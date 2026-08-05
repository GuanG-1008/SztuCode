# 功能：验证 BashTool 动态权限分级逻辑
# 设计：覆盖只读命令降级、危险路径维持高级别、未知命令等场景
from __future__ import annotations

from sztu_code.core.tools.base import ToolPermission
from sztu_code.core.tools.builtin.bash import BashTool, _extract_cmd_name, _has_dangerous_paths


def _classify(command: str) -> ToolPermission:
    return BashTool().classify_permission({"command": command})


# 功能：验证只读命令 + 安全路径降级为 workspace_write
# 设计：ls、cat、git status 等纯读取命令应返回较低的权限级别
def test_bash_read_only_commands_downgraded() -> None:
    assert _classify("ls -la") == ToolPermission.WORKSPACE_WRITE
    assert _classify("cat file.txt") == ToolPermission.WORKSPACE_WRITE
    assert _classify("git status") == ToolPermission.WORKSPACE_WRITE
    assert _classify("grep -r pattern .") == ToolPermission.WORKSPACE_WRITE
    assert _classify("echo hello") == ToolPermission.WORKSPACE_WRITE
    assert _classify("wc -l file.txt") == ToolPermission.WORKSPACE_WRITE


# 功能：验证包含绝对路径的只读命令维持 danger_full_access
# 设计：即使命令是只读的，访问 /etc 等绝对路径应升级权限
def test_bash_read_only_with_dangerous_path_keeps_high() -> None:
    assert _classify("cat /etc/passwd") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("ls /root") == ToolPermission.DANGER_FULL_ACCESS


# 功能：验证包含 .. 的命令维持 danger_full_access
# 设计：父目录穿越即使配合只读命令也是危险的
def test_bash_parent_traversal_is_dangerous() -> None:
    assert _classify("cat ../../secret.txt") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("ls ../..") == ToolPermission.DANGER_FULL_ACCESS


# 功能：验证包含 sudo 的命令维持 danger_full_access
# 设计：任何包含 sudo 的命令都应是最危险的级别
def test_bash_sudo_is_dangerous() -> None:
    assert _classify("sudo ls") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("sudo cat /etc/shadow") == ToolPermission.DANGER_FULL_ACCESS


# 功能：验证非只读命令默认 danger_full_access
# 设计：rm、mv、curl 等修改系统状态的命令保持最高权限
def test_bash_write_commands_are_dangerous() -> None:
    assert _classify("rm -rf /tmp/test") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("curl http://example.com") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("pip install requests") == ToolPermission.DANGER_FULL_ACCESS
    assert _classify("npm install") == ToolPermission.DANGER_FULL_ACCESS


# 功能：验证空命令返回 danger_full_access
# 设计：空字符串或无命令应保守地返回最高级别
def test_bash_empty_command() -> None:
    assert _classify("") == ToolPermission.DANGER_FULL_ACCESS


# 功能：验证 _extract_cmd_name 从各种格式中正确提取命令名
# 设计：覆盖路径前缀、赋值前缀、引号等场景
def test_extract_cmd_name() -> None:
    assert _extract_cmd_name("ls -la") == "ls"
    assert _extract_cmd_name("  git status  ") == "git"
    assert _extract_cmd_name("./script.sh") == "script.sh"
    assert _extract_cmd_name("/usr/bin/python") == "python"
    assert _extract_cmd_name("VAR=val cmd") == "cmd"


# 功能：验证 _has_dangerous_paths 检测危险模式
# 设计：绝对路径、~、..、$HOME、sudo 等应被检出
def test_dangerous_path_detection() -> None:
    assert _has_dangerous_paths("cat /etc/hosts")
    assert _has_dangerous_paths("ls ~/Documents")
    assert _has_dangerous_paths("cd ../../../")
    assert _has_dangerous_paths("echo $HOME")
    assert _has_dangerous_paths("sudo reboot")
    assert not _has_dangerous_paths("ls -la")
    assert not _has_dangerous_paths("cat file.txt")
    assert not _has_dangerous_paths("git status")


# 功能：验证 Windows 风格命令被预处理为 git-bash 可用形式
# 设计：覆盖 cd /d、前导 dir、Windows 盘符路径三种常见误用（raw 字符串保证反斜杠字面量）
def test_preprocess_windows_commands() -> None:
    from sztu_code.core.tools.builtin.bash import _preprocess_command

    assert _preprocess_command(r"cd /d C:\repo\src && pwd") == "cd /c/repo/src && pwd"
    assert _preprocess_command("dir") == "ls"
    assert _preprocess_command(r"cd /d D:\data") == "cd /d/data"
    # 不含盘符的命令保持原样（避免破坏正则转义）
    assert _preprocess_command(r"grep '\d+' file") == r"grep '\d+' file"
    # cd 不带 /d 不受影响
    assert _preprocess_command("cd src && ls") == "cd src && ls"


# 功能：验证安装/更新依赖命令被 bash 工具直接拦截不执行
# 设计：pip/npm/apt/ensurepip 等命令应返回 is_error 且内容含 blocked，不触发子进程
async def test_install_commands_blocked() -> None:
    from sztu_code.core.tools.builtin.bash import _BLOCKED_INSTALL_RE, BashTool

    assert _BLOCKED_INSTALL_RE.search("pip install requests")
    assert _BLOCKED_INSTALL_RE.search("python -m pip install -e .")
    assert _BLOCKED_INSTALL_RE.search("npm install")
    assert _BLOCKED_INSTALL_RE.search("apt-get update && apt-get install curl")
    assert _BLOCKED_INSTALL_RE.search("ensurepip")
    assert _BLOCKED_INSTALL_RE.search("conda install numpy")
    assert not _BLOCKED_INSTALL_RE.search("git status")
    assert not _BLOCKED_INSTALL_RE.search("pytest tests/foo.py")
    assert not _BLOCKED_INSTALL_RE.search("echo hello world")

    result = await BashTool().invoke({"command": "pip install requests"})
    assert result.is_error
    assert "blocked" in result.content.lower()
