from __future__ import annotations

import pytest

from sztu_code.core.app import CoreApp
from sztu_code.core.bus.envelope import HandlerError
from sztu_code.core.config import SztuConfig, get_config
from sztu_code.core.mcp.server import McpServerManager
from sztu_code.core.permissions.manager import PermissionManager


def _configured_app() -> CoreApp:
    app = CoreApp()
    app._config = SztuConfig()
    app._config.llm.default_model = "configured-model"
    app._permission_manager = PermissionManager()
    app._mcp_manager = McpServerManager()
    return app


async def test_settings_update_applies_to_the_next_run_configuration(
    tmp_path, monkeypatch,
) -> None:
    settings_path = tmp_path / "client-settings.json"
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(settings_path))
    monkeypatch.setenv("SZTU_CONFIG", str(tmp_path / "missing-config.toml"))
    monkeypatch.delenv("SZTU_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("SZTU_LLM_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("KAMA_LLM_DEFAULT_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)
    app = _configured_app()

    result = await app._settings_update_handler(
        {
            "provider": "openai",
            "model": "gpt-4o",
            "base_url": "https://example.test/v1",
            "api_key": "secret-value",
            "permission_mode": "plan",
        }
    )

    assert result.updated == ["provider", "model", "base_url", "api_key", "permission_mode"]
    assert result.settings.provider == "openai"
    assert result.settings.model == "gpt-4o"
    assert result.settings.permission_mode == "plan"
    assert result.settings.base_url == "https://example.test/v1"
    assert "secret-value" not in str(result.model_dump())
    assert result.settings.persistent is True
    assert settings_path.exists()

    reloaded = get_config()
    assert reloaded.llm.provider == "openai"
    assert reloaded.llm.default_model == "gpt-4o"
    assert reloaded.llm.base_url == "https://example.test/v1"
    assert reloaded.llm.api_key == "secret-value"
    assert reloaded.permission.mode == "plan"

    status = await app._provider_status_handler({})
    assert status.api_key_configured is True
    assert status.custom_endpoint_configured is True
    assert status.ready_for_next_run is True
    assert "secret-value" not in str(status.model_dump())


async def test_provider_status_reports_presence_without_exposing_credentials(
    monkeypatch,
) -> None:
    app = _configured_app()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret-value")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.test")

    result = await app._provider_status_handler({})
    payload = result.model_dump()

    assert result.ready_for_next_run is True
    assert result.custom_endpoint_configured is True
    assert "secret-value" not in str(payload)
    assert isinstance(result.skills, list)


async def test_provider_status_requires_a_model_for_a_ready_run(monkeypatch) -> None:
    app = _configured_app()
    app._config.llm.default_model = ""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret-value")

    result = await app._provider_status_handler({})

    assert result.model == ""
    assert result.ready_for_next_run is False


async def test_model_profiles_save_select_and_delete_without_exposing_keys(
    tmp_path, monkeypatch,
) -> None:
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(tmp_path / "client-settings.json"))
    app = _configured_app()

    first = await app._model_profile_save_handler(
        {
            "name": "DeepSeek V3",
            "vendor": "DeepSeek",
            "provider": "openai",
            "model": "deepseek-chat",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "secret-one",
        }
    )
    first_profile = next(item for item in first.models if item.name == "DeepSeek V3")
    first_id = first_profile.id
    assert first_profile.has_api_key is True
    assert first_profile.is_current is True
    assert "secret-one" not in str(first.model_dump())

    second = await app._model_profile_save_handler(
        {
            "name": "Claude",
            "vendor": "Anthropic",
            "provider": "anthropic",
            "model": "claude-sonnet",
            "base_url": "",
            "api_key": "secret-two",
        }
    )
    second_id = next(item.id for item in second.models if item.is_current)
    selected = await app._model_profile_select_handler({"model_id": first_id})
    assert selected.settings.model == "deepseek-chat"
    assert next(item for item in selected.models if item.id == first_id).is_current

    with pytest.raises(HandlerError):
        await app._model_profile_delete_handler({"model_id": first_id})
    deleted = await app._model_profile_delete_handler({"model_id": second_id})
    assert second_id not in [item.id for item in deleted.models]
    assert first_id in [item.id for item in deleted.models]


# 功能：验证校园 DeepSeek 内置模型出现在列表中并读取专用环境变量凭证
# 设计：使用临时客户端配置隔离用户状态，选择内置项后检查模型、端点和就绪状态
async def test_campus_deepseek_builtin_profile_uses_environment_key(
    tmp_path, monkeypatch,
) -> None:
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(tmp_path / "client-settings.json"))
    monkeypatch.setenv("SZTU_CAMPUS_DEEPSEEK_API_KEY", "campus-secret")
    app = _configured_app()

    listed = await app._model_profile_list_handler({})
    campus = next(item for item in listed.models if item.id == "builtin-campus-deepseek-v4-pro")
    assert campus.name == "DeepSeek V4 Pro(校园网)"
    assert campus.model == "deepseek-v4-pro"
    assert campus.base_url == "https://apiai.sztu.edu.cn/v1"
    assert campus.has_api_key is True
    assert campus.builtin is True

    selected = await app._model_profile_select_handler({"model_id": campus.id})
    status = await app._provider_status_handler({})
    assert selected.settings.provider == "openai"
    assert selected.settings.model == "deepseek-v4-pro"
    assert selected.settings.base_url == "https://apiai.sztu.edu.cn/v1"
    assert status.ready_for_next_run is True
    assert "campus-secret" not in str(selected.model_dump())

    with pytest.raises(HandlerError):
        await app._model_profile_delete_handler({"model_id": campus.id})

    monkeypatch.delenv("SZTU_CAMPUS_DEEPSEEK_API_KEY")
    monkeypatch.setenv("OPENAI_API_KEY", "unrelated-openai-secret")
    missing_campus_key = await app._provider_status_handler({})
    assert missing_campus_key.ready_for_next_run is False
