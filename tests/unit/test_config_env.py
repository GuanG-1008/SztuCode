from __future__ import annotations

from pathlib import Path

import pytest

from sztu_code.core.config import get_config


def _write_env(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


# 功能：验证 .env 文件中的值被正确加载并覆盖内建默认值
# 设计：写 .env 到临时目录并 chdir 进去，清除同名系统环境变量排除干扰，确认 .env 加载路径有效
def test_dotenv_base_loaded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_file = tmp_path / ".env"
    _write_env(env_file, "SZTU_PORT=9999\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SZTU_PORT", raising=False)

    cfg = get_config()

    assert cfg.port == 9999


# 功能：验证系统环境变量的优先级高于 .env 文件中的值
# 设计：.env 写 9999，系统环境变量写 8888，确认最终值为 8888，对应四级优先链的顶层约束
def test_system_env_overrides_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_file = tmp_path / ".env"
    _write_env(env_file, "SZTU_PORT=9999\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SZTU_PORT", "8888")

    cfg = get_config()

    assert cfg.port == 8888


# 功能：验证 .env 文件不存在时静默跳过，使用内建默认值（不抛异常）
# 设计：chdir 到空目录，清除系统环境变量，确认 get_config() 不因 .env 缺失而崩溃，默认端口为 7437
def test_missing_env_file_silent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SZTU_PORT", raising=False)

    cfg = get_config()

    assert cfg.port == 7437


def test_model_is_empty_when_no_model_environment_variable_is_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(tmp_path / "missing-settings.json"))
    monkeypatch.setenv("SZTU_CONFIG", str(tmp_path / "missing-config.toml"))
    monkeypatch.delenv("SZTU_LLM_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("KAMA_LLM_DEFAULT_MODEL", raising=False)

    cfg = get_config()

    assert cfg.llm.default_model == ""


def test_legacy_kama_model_environment_variable_is_supported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_env(tmp_path / ".env", "KAMA_LLM_DEFAULT_MODEL=legacy-model\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(tmp_path / "missing-settings.json"))
    monkeypatch.setenv("SZTU_CONFIG", str(tmp_path / "missing-config.toml"))
    monkeypatch.delenv("SZTU_LLM_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("KAMA_LLM_DEFAULT_MODEL", raising=False)

    cfg = get_config()

    assert cfg.llm.default_model == "legacy-model"


def test_sztu_model_environment_variable_takes_priority_over_legacy_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_env(
        tmp_path / ".env",
        "KAMA_LLM_DEFAULT_MODEL=legacy-model\nSZTU_LLM_DEFAULT_MODEL=sztu-model\n",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SZTU_CLIENT_SETTINGS", str(tmp_path / "missing-settings.json"))
    monkeypatch.setenv("SZTU_CONFIG", str(tmp_path / "missing-config.toml"))
    monkeypatch.delenv("KAMA_LLM_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("SZTU_LLM_DEFAULT_MODEL", raising=False)

    cfg = get_config()

    assert cfg.llm.default_model == "sztu-model"


# 功能：验证 .env 中设置的 SZTU_CONFIG 能正确影响 TOML 配置文件的加载路径
# 设计：.env 指向自定义 TOML 文件，TOML 中写入不同端口，确认 .env 在 TOML 加载前被读取（优先级链的正确顺序）
def test_dotenv_before_toml_kama_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    toml_path = tmp_path / "custom.toml"
    toml_path.write_bytes(b'[core]\nport = 5555\n')

    env_file = tmp_path / ".env"
    _write_env(env_file, f"SZTU_CONFIG={toml_path}\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SZTU_CONFIG", raising=False)
    monkeypatch.delenv("SZTU_PORT", raising=False)

    cfg = get_config()

    assert cfg.port == 5555


# 功能：验证同一变量经过完整四级优先链后，最终值为最高优先级来源（系统环境变量）
# 设计：同时设置默认值(7437)/TOML(6000)/.env(7000)/系统环境变量(8000)，确认最终值为 8000，是优先级链的综合正确性验证
def test_priority_chain_full(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # 默认值：7437
    # TOML：6000
    # .env：7000
    # 系统环境变量：8000（最高）
    toml_path = tmp_path / "sztu.toml"
    toml_path.write_bytes(b'[core]\nport = 6000\n')

    env_file = tmp_path / ".env"
    _write_env(env_file, "SZTU_PORT=7000\n")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SZTU_CONFIG", str(toml_path))
    monkeypatch.setenv("SZTU_PORT", "8000")

    cfg = get_config()

    assert cfg.port == 8000


# 功能：验证 [budget] TOML 段的 max_tokens/max_wall_clock_s 被解析
# 设计：写含 [budget] 的 TOML 并通过 SZTU_CONFIG 加载，断言两个字段值
def test_budget_toml_parsed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    toml_path = tmp_path / "sztu.toml"
    toml_path.write_bytes(b"[budget]\nmax_tokens = 1234\nmax_wall_clock_s = 60\n")
    monkeypatch.setenv("SZTU_CONFIG", str(toml_path))
    cfg = get_config()
    assert cfg.budget.max_tokens == 1234
    assert cfg.budget.max_wall_clock_s == 60


# 功能：验证 [agent] 的收尾/结语/卡死键被解析
# 设计：写含新键的 TOML，断言 wrap_up/grace_step/stuck_max_failures/stuck_max_total
def test_agent_budget_keys_toml_parsed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    toml_path = tmp_path / "sztu.toml"
    toml_path.write_bytes(
        b"[agent]\nwrap_up_on_max_steps = false\n"
        b"grace_step_on_max_steps = false\n"
        b"stuck_max_failures = 5\nstuck_max_total = 2\n"
    )
    monkeypatch.setenv("SZTU_CONFIG", str(toml_path))
    cfg = get_config()
    assert cfg.agent.wrap_up_on_max_steps is False
    assert cfg.agent.grace_step_on_max_steps is False
    assert cfg.agent.stuck_max_failures == 5
    assert cfg.agent.stuck_max_total == 2


# 功能：验证 SZTU_GRACE_STEP_ON_MAX_STEPS 环境变量可关闭结语宽限步
# 设计：设 env=false，断言 get_config 读到 False；未设置时保持默认 True
def test_grace_step_env_var_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SZTU_GRACE_STEP_ON_MAX_STEPS", "false")
    cfg = get_config()
    assert cfg.agent.grace_step_on_max_steps is False
    monkeypatch.delenv("SZTU_GRACE_STEP_ON_MAX_STEPS")
    cfg = get_config()
    assert cfg.agent.grace_step_on_max_steps is True


# 功能：验证 max_steps 默认值为 0（不限步数），TOML 显式写 0 也合法
# 设计：无覆盖时默认 0；写 [agent] max_steps=0 不报错仍为 0（0 从"第 1 步即终止"改为"不限"）
def test_max_steps_default_unlimited(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SZTU_MAX_STEPS", raising=False)
    cfg = get_config()
    assert cfg.agent.max_steps == 0
    toml_path = tmp_path / "sztu.toml"
    toml_path.write_bytes(b"[agent]\nmax_steps = 0\n")
    monkeypatch.setenv("SZTU_CONFIG", str(toml_path))
    cfg = get_config()
    assert cfg.agent.max_steps == 0


# 功能：验证 SZTU_MAX_STEPS 允许 0（不限），负数才报错
# 设计：env=0 读到 0；env=-1 抛 SystemExit
def test_max_steps_env_accepts_zero_rejects_negative(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SZTU_MAX_STEPS", "0")
    cfg = get_config()
    assert cfg.agent.max_steps == 0
    monkeypatch.setenv("SZTU_MAX_STEPS", "-1")
    with pytest.raises(SystemExit):
        get_config()


# 功能：验证 SZTU_BUDGET_* 环境变量覆盖 budget 配置
# 设计：直接设环境变量，断言 get_config 读到对应值
def test_budget_env_vars_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SZTU_BUDGET_MAX_TOKENS", "999")
    monkeypatch.setenv("SZTU_BUDGET_MAX_WALL_CLOCK_S", "42")
    cfg = get_config()
    assert cfg.budget.max_tokens == 999
    assert cfg.budget.max_wall_clock_s == 42


# 功能：未知 [budget] 键应导致配置退出
# 设计：写含 foo 键的 TOML，断言抛出 SystemExit
def test_unknown_budget_key_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    toml_path = tmp_path / "sztu.toml"
    toml_path.write_bytes(b"[budget]\nfoo = 1\n")
    monkeypatch.setenv("SZTU_CONFIG", str(toml_path))
    with pytest.raises(SystemExit):
        get_config()
