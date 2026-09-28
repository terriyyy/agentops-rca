from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class RunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_key: str = Field(min_length=1, max_length=200)
    attempt_index: int = Field(ge=1, le=10000)
    telemetry: str
    report: str | None = None
    outcome: str | None = None
    feedback: str | None = None
    source_algorithm: str = Field(default="PROBE", max_length=100)

    @field_validator("telemetry", "report", "outcome", "feedback")
    @classmethod
    def flat_filename(cls, value):
        if value is not None and (
            not value or len(value) > 200 or value in {".", ".."}
            or any(c in value for c in '/\\:\x00')
            or value.startswith('.') or value != value.strip()
        ):
            raise ValueError("文件名必须是不含路径的普通文件名")
        return value


class ImportManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["0.1"] = "0.1"
    source_namespace: str = Field(min_length=1, max_length=200)
    task_id: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=20000)
    sample_kind: Literal["historical", "synthetic", "derived"] = "historical"
    runs: Annotated[list[RunInput], Field(min_length=1, max_length=10)]

    @model_validator(mode="after")
    def unique_runs(self):
        if len({r.run_key for r in self.runs}) != len(self.runs):
            raise ValueError("run_key 不能重复")
        if len({r.attempt_index for r in self.runs}) != len(self.runs):
            raise ValueError("同一导入清单中的轮次不能重复")
        return self
