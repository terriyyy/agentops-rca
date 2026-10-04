"""Read-only observed usage. No inference, pricing, or changes to source facts."""
import json
import math
from collections import defaultdict
from datetime import datetime

MAX_COUNT = 2**53 - 1


def object_value(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, RecursionError):
            return {}
    return value if isinstance(value, dict) else {}


def count(value):
    return value if type(value) is int and 0 <= value <= MAX_COUNT else None


def normalize_usage(output):
    output = object_value(output)
    # These are provider/SDK envelopes, never fields inside generated content.
    candidates = [('usage', output.get('usage')),
                  ('usage_metadata', output.get('usage_metadata')),
                  ('response_metadata.token_usage', object_value(output.get('response_metadata')).get('token_usage'))]
    for path, raw in candidates:
        raw = object_value(raw)
        values = {target: next((count(raw[key]) for key in keys if count(raw.get(key)) is not None), None)
                  for target, keys in [('input_tokens', ('input_tokens', 'prompt_tokens')),
                                       ('output_tokens', ('output_tokens', 'completion_tokens')),
                                       ('total_tokens', ('total_tokens',))]}
        if all(value is None for value in values.values()):
            continue
        derived = False
        parts = values['input_tokens'], values['output_tokens']
        warnings = []
        if all(value is not None for value in parts):
            calculated = sum(parts)
            if values['total_tokens'] is None and calculated <= MAX_COUNT:
                values['total_tokens'] = calculated
                derived = True
            elif values['total_tokens'] is not None and calculated != values['total_tokens']:
                warnings.append('total_differs_from_parts')
        # Cache/reasoning are often subsets. Never add them again to the total.
        return {**values, 'source': 'output.' + path, 'total_derived': derived, 'warnings': warnings}
    return None


def timestamp(event):
    try:
        value = datetime.fromisoformat(event.get('occurred_at', '').replace('Z', '+00:00'))
        return value.timestamp() * 1000 if value.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return None


def phase(event):
    explicit = object_value(event.get('capture')).get('phase')
    if explicit in ('start', 'end', 'end_only'):
        return 'start' if explicit == 'start' else 'end'
    if event.get('name') == 'LLM_REQUEST':
        return 'start'
    if event.get('name') in ('LLM_RESPONSE', 'LLM_ERROR'):
        return 'end'
    # Legacy LLM records can be standalone responses, without a known start.
    if event.get('output') is not None:
        return 'end'
    return 'unknown'


def source_model(start, end):
    candidates = [object_value((start or {}).get('input')).get('model'),
                  object_value((end or {}).get('output')).get('model'),
                  object_value(object_value((end or {}).get('output')).get('response_metadata')).get('model_name')]
    return next((value[:200] for value in candidates if isinstance(value, str) and value.strip()), None)


def llm_call(start, end):
    primary = end or start
    duration = (end or {}).get('duration_ms')
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
        duration = None
    state = 'pending' if end is None else 'failed' if end.get('raw_ok') is False or end.get('error_signature') else 'returned'
    return {'event_id': primary['event_id'], 'evidence_id': primary.get('evidence_id'),
            'start_event_id': start['event_id'] if start else None,
            'end_event_id': end['event_id'] if end else None, 'position': primary['position'],
            'state': state, 'response_only': start is None,
            'model': source_model(start, end), 'duration_ms': duration,
            'usage': normalize_usage((end or {}).get('output'))}


def run_metrics(run, events):
    groups = defaultdict(list)
    calls, unknown, ambiguous = [], 0, 0
    for event in events:
        if event['kind'] != 'llm':
            continue
        if phase(event) == 'unknown':
            unknown += 1
            continue
        cid = event.get('correlation_id')
        if cid:
            groups[(event.get('producer_id'), cid)].append(event)
        else:
            if phase(event) == 'end':
                calls.append(llm_call(None, event))
            else:
                unknown += 1  # Unlinked starts may belong to recorded responses.
    for group in groups.values():
        starts = [event for event in group if phase(event) == 'start']
        ends = [event for event in group if phase(event) == 'end']
        if len(starts) > 1 or len(ends) > 1 or (starts and ends and starts[0]['position'] >= ends[0]['position']):
            ambiguous += len(group)
            continue  # Duplicate correlation cannot establish a unique invocation.
        calls.append(llm_call(starts[0] if starts else None, ends[0] if ends else None))
    calls.sort(key=lambda item: item['position'])
    responded = [call for call in calls if call['end_event_id'] is not None]
    usage_calls = [call for call in responded if call['usage'] is not None]

    def aggregate(field):
        values = [call['usage'][field] for call in usage_calls if call['usage'][field] is not None]
        total = sum(values) if values else None
        return {'value': total if total is None or total <= MAX_COUNT else None, 'responses': len(values)}

    tool_groups = defaultdict(list)
    tool_calls = [event for event in events if event['kind'] == 'tool_call']
    for event in events:
        if event['kind'] in ('tool_call', 'tool_return') and event.get('correlation_id'):
            tool_groups[event['correlation_id']].append(event)
    returned = []
    for group in tool_groups.values():
        starts = [event for event in group if event['kind'] == 'tool_call']
        ends = [event for event in group if event['kind'] == 'tool_return']
        if len(starts) == len(ends) == 1 and starts[0]['position'] < ends[0]['position'] and starts[0]['name'] == ends[0]['name']:
            if starts[0].get('producer_id') != ends[0].get('producer_id'):
                continue
            if starts[0].get('parent_source_id') and ends[0].get('parent_source_id') and starts[0]['parent_source_id'] != ends[0]['parent_source_id']:
                continue
            returned.append(ends[0])
    times = [value for event in events if (value := timestamp(event)) is not None]
    elapsed = max(times) - min(times) if len(times) > 1 else None
    return {'run_id': run['run_id'], 'event_count': len(events), 'in_progress': run['execution_status'] == 'running',
            'time': {'recorded_ms': elapsed, 'timed_events': len(times)},
            'llm': {'observed': len(calls), 'completed': len(responded),
                    'pending': len(calls) - len(responded), 'failed': sum(call['state'] == 'failed' for call in calls),
                    'response_only': sum(call['response_only'] for call in calls),
                    'ambiguous_events': ambiguous, 'unclassified_events': unknown, 'calls': calls},
            'tokens': {'input': aggregate('input_tokens'), 'output': aggregate('output_tokens'),
                       'total': aggregate('total_tokens'), 'with_usage': len(usage_calls),
                       'responses': len(responded),
                       'conflicting_responses': sum(bool(call['usage']['warnings']) for call in usage_calls)},
            'tools': {'observed': len(tool_calls), 'paired': len(returned),
                      'failed': sum(event.get('tool_status') == 'failed' for event in returned),
                      'unpaired_calls': len(tool_calls) - len(returned)}}
