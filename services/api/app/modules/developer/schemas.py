import uuid

from pydantic import BaseModel, Field, field_validator


class StudioCreate(BaseModel):
    name: str = Field(min_length=2, max_length=60)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Studio name is too short.")
        return value


class StudioOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    status: str
    my_role: str
