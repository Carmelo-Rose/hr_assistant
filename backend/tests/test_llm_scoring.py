import pytest

from app.services import llm_scoring


def test_llm_config_rejects_non_ascii_api_key():
    cfg = {
        "base_url": "https://example.com/v1",
        "api_key": "请输入你的key",
        "model": "qwen-plus",
    }

    with pytest.raises(llm_scoring.LLMConfigError) as exc:
        llm_scoring._validate_config(cfg)

    assert "LLM_API_KEY" in str(exc.value)
    assert "backend/.env" in str(exc.value)


def test_llm_config_accepts_ascii_values():
    cfg = {
        "base_url": "https://example.com/v1",
        "api_key": "sk-test",
        "model": "qwen-plus",
    }

    llm_scoring._validate_config(cfg)
