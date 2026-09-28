"""Versioned, bounded protocol for local collectors (not historical imports)."""
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, AwareDatetime, field_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class CreateRun(Strict):
    request_id: str = Field(min_length=16, max_length=80)
    write_token: str = Field(min_length=32, max_length=128)
    task_id: str | None = None
    goal: str = Field(min_length=1, max_length=2000)
    sample_kind: Literal['live', 'synthetic'] = 'live'
    adapter: Literal['python-sdk', 'process-only'] = 'python-sdk'


class LiveEvent(Strict):
    schema_version: Literal['0.2'] = '0.2'
    event_id: str = Field(min_length=1, max_length=80)
    producer_id: str = Field(min_length=1, max_length=80)
    producer_seq: int = Field(ge=1, le=20000, strict=True)
    occurred_at: AwareDatetime
    kind: Literal['tool_call', 'tool_return', 'llm', 'log', 'event', 'verification']
    name: str = Field(min_length=1, max_length=200)
    source_span_id: str | None = Field(default=None, max_length=160)
    parent_source_id: str | None = Field(default=None, max_length=160)
    correlation_id: str | None = Field(default=None, max_length=160)
    input: object = None
    output: object = None
    ok: bool | None = None
    duration_ms: float | None = Field(default=None, ge=0)
    error_signature: str | None = Field(default=None, max_length=1000)

    @field_validator('input','output')
    @classmethod
    def finite_json(cls,value):
        try: json.dumps(value,allow_nan=False)
        except (ValueError,TypeError,RecursionError): raise ValueError('事件内容必须是有限 JSON 值')
        return value


class Batch(Strict):
    events: list[LiveEvent] = Field(min_length=1, max_length=100)


class Finish(Strict):
    exit_code: int = Field(strict=True)
    reason: Literal['exit', 'interrupted', 'launch_failed'] = 'exit'
    producers: dict[str, int]
    dropped: int = Field(default=0, ge=0, strict=True)

    def validate_counts(self):
        if len(self.producers) > 64 or any(not k or len(k)>80 or type(v) is not int or v<1 or v>20000 for k,v in self.producers.items()):
            raise ValueError('生产者序号范围无效')
