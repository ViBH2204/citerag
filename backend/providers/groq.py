
"""GroqProvider — fast hosted LLM provider using the Groq API."""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator

from groq import AsyncGroq


class GroqProvider:
    """LLM provider backed by Groq's asynchronous chat completions API."""

    name: str = "groq"
    _DEFAULT_MODEL = "openai/gpt-oss-20b"

    def __init__(
        self,
        api_key: str | None = None,
        model_name: str | None = None,
    ) -> None:
        resolved_key = api_key or os.getenv("GROQ_API_KEY")

        if not resolved_key:
            raise RuntimeError(
                "GroqProvider requires GROQ_API_KEY to be set."
            )

        self._client = AsyncGroq(
            api_key=resolved_key,
            max_retries=0,
        )

        self._model = (
            model_name
            or os.getenv("GROQ_MODEL", self._DEFAULT_MODEL)
        )

    async def generate(
        self,
        prompt: str,
        *,
        timeout_s: float = 30.0,
        stream: bool = False,
    ) -> AsyncIterator[str]:
        return self._generate_impl(
            prompt,
            timeout_s=timeout_s,
            stream=stream,
        )

    async def _generate_impl(
        self,
        prompt: str,
        *,
        timeout_s: float,
        stream: bool,
    ) -> AsyncIterator[str]:

        try:
            if stream:
                response_stream = await asyncio.wait_for(
                    self._client.chat.completions.create(
                        model=self._model,
                        messages=[
                            {
                                "role": "user",
                                "content": prompt,
                            }
                        ],
                        temperature=0.2,
                        max_completion_tokens=1024,
                        stream=True,
                    ),
                    timeout=timeout_s,
                )

                iterator = response_stream.__aiter__()

                while True:
                    try:
                        chunk = await asyncio.wait_for(
                            iterator.__anext__(),
                            timeout=timeout_s,
                        )
                    except StopAsyncIteration:
                        break

                    content = chunk.choices[0].delta.content

                    if content:
                        yield content

            else:
                response = await asyncio.wait_for(
                    self._client.chat.completions.create(
                        model=self._model,
                        messages=[
                            {
                                "role": "user",
                                "content": prompt,
                            }
                        ],
                        temperature=0.2,
                        max_completion_tokens=1024,
                    ),
                    timeout=timeout_s,
                )

                answer = response.choices[0].message.content or ""
                yield answer

        except asyncio.TimeoutError:
            raise

        except Exception as exc:
            raise RuntimeError(
                f"GroqProvider API error "
                f"(model={self._model}): {exc}"
            ) from exc
