from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from sztu_code.core.workspace.project_profile import (
    ValidationCategory,
    detect_project_profile,
    render_project_profile_context,
)


# 从画像中按相对路径取得唯一子项目，便于断言路径归属。
def _project_at(profile: object, path: str) -> object:
    projects = getattr(profile, "projects")
    return next(project for project in projects if project.path == path)


# 将技术结论转换为名称集合，避免测试依赖列表内部排序细节。
def _names(findings: object) -> set[str]:
    return {finding.name for finding in findings}


# 将验证命令按分类取出，直接验证分层后的建议而不是原始配置文本。
def _commands(project: object, category: ValidationCategory) -> list[str]:
    return [item.command for item in project.validation_plan if item.category == category]


# 功能：识别带锁文件和工具配置的 Python 项目，并生成完整的分层验证建议。
# 设计：使用临时目录中的 pyproject、uv 锁文件和集成测试目录，覆盖清单、框架、构建工具与路径证据的组合信号。
def test_detects_python_profile_and_layered_plan(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        """
[project]
name = "api"
dependencies = ["fastapi", "pytest", "ruff", "mypy"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]

[tool.pytest.ini_options]
markers = ["integration"]
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "uv.lock").write_text("version = 1\n", encoding="utf-8")
    (tmp_path / "tests" / "integration").mkdir(parents=True)

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, ".")

    assert _names(project.languages) == {"Python"}
    assert "FastAPI" in _names(project.frameworks)
    assert "uv" in _names(project.package_managers)
    assert "Hatchling" in _names(project.build_tools)
    assert "uv run ruff format --check ." in _commands(project, ValidationCategory.FORMAT)
    assert "uv run ruff check ." in _commands(project, ValidationCategory.STATIC_CHECK)
    assert "uv run pytest" in _commands(project, ValidationCategory.UNIT_TEST)
    assert "uv run pytest tests/integration" in _commands(
        project, ValidationCategory.INTEGRATION_TEST
    )
    assert "uv build" in _commands(project, ValidationCategory.BUILD)
    assert any(item.path == "pyproject.toml" for item in project.evidence)
    assert all(command.recommendation_only for command in project.validation_plan)


# 功能：识别仅使用 setup.py 的传统 Python 项目，并保留可解释的 Setuptools 构建结论。
# 设计：不放置 pyproject 或 requirements，覆盖旧式清单路径，防止框架证据来源为空时越界。
def test_detects_setuptools_project_without_pyproject_or_requirements(tmp_path: Path) -> None:
    (tmp_path / "setup.py").write_text(
        "from setuptools import setup\nsetup(name='legacy', install_requires=['flask'])\n",
        encoding="utf-8",
    )

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, ".")

    assert _names(project.languages) == {"Python"}
    assert "Flask" in _names(project.frameworks)
    assert "pip" in _names(project.package_managers)
    assert "Setuptools" in _names(project.build_tools)
    assert "python -m build" in _commands(project, ValidationCategory.BUILD)


# 功能：识别 Node.js 的框架、包管理器和 package scripts，并按五类验证层生成建议。
# 设计：只从 package.json 的声明式字段和 pnpm 锁文件读取信号，断言建议使用脚本名称而不会解析或执行脚本正文。
def test_detects_node_profile_from_manifest_lockfile_and_scripts(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "name": "web",
                "packageManager": "pnpm@9.0.0",
                "scripts": {
                    "format": "prettier --check .",
                    "lint": "eslint .",
                    "test": "vitest run",
                    "test:integration": "playwright test",
                    "build": "vite build",
                },
                "dependencies": {"react": "^19.0.0"},
                "devDependencies": {"vite": "^6.0.0"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, ".")

    assert _names(project.languages) == {"Node.js"}
    assert "React" in _names(project.frameworks)
    assert "pnpm" in _names(project.package_managers)
    assert "Vite" in _names(project.build_tools)
    assert "pnpm run format" in _commands(project, ValidationCategory.FORMAT)
    assert "pnpm run lint" in _commands(project, ValidationCategory.STATIC_CHECK)
    assert "pnpm run test" in _commands(project, ValidationCategory.UNIT_TEST)
    assert "pnpm run test:integration" in _commands(project, ValidationCategory.INTEGRATION_TEST)
    assert "pnpm run build" in _commands(project, ValidationCategory.BUILD)
    assert all("prettier --check" not in command.command for command in project.validation_plan)


# 功能：识别 Maven Java 项目中的框架和验证工具，不把构建插件当成自动执行动作。
# 设计：以 pom、wrapper、源码目录和插件标识组成多重证据，分别断言格式化、静态检查、单测、集成与构建建议。
def test_detects_java_maven_profile_and_validation_layers(tmp_path: Path) -> None:
    (tmp_path / "pom.xml").write_text(
        """
<project>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
  <build><plugins><plugin>spotless</plugin><plugin>checkstyle</plugin><plugin>maven-failsafe-plugin</plugin></plugins></build>
</project>
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "mvnw").write_text("#!/bin/sh\n", encoding="utf-8")
    (tmp_path / "src" / "main" / "java").mkdir(parents=True)

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, ".")

    assert _names(project.languages) == {"Java"}
    assert "Spring Boot" in _names(project.frameworks)
    assert "Maven" in _names(project.package_managers)
    assert "Maven" in _names(project.build_tools)
    assert "./mvnw spotless:check" in _commands(project, ValidationCategory.FORMAT)
    assert "./mvnw checkstyle:check" in _commands(project, ValidationCategory.STATIC_CHECK)
    assert "./mvnw test" in _commands(project, ValidationCategory.UNIT_TEST)
    assert "./mvnw verify" in _commands(project, ValidationCategory.INTEGRATION_TEST)
    assert "./mvnw package" in _commands(project, ValidationCategory.BUILD)


# 功能：识别 Gradle 多模块项目，并将单个子模块标注为 Monorepo 内的独立 Java 项目。
# 设计：使用 settings.gradle、Java 插件和真实 .java 源码组成组合信号，断言父聚合配置不会让子模块命令丢失路径归属。
def test_detects_gradle_multi_module_java_project(tmp_path: Path) -> None:
    (tmp_path / "settings.gradle").write_text("include 'service'\n", encoding="utf-8")
    (tmp_path / "service" / "src" / "main" / "java").mkdir(parents=True)
    (tmp_path / "service" / "build.gradle").write_text(
        "plugins { id 'java' }\n",
        encoding="utf-8",
    )
    (tmp_path / "service" / "src" / "main" / "java" / "App.java").write_text(
        "class App {}\n",
        encoding="utf-8",
    )

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, "service")

    assert profile.monorepo is True
    assert _names(project.languages) == {"Java"}
    assert "Gradle" in _names(project.build_tools)
    assert "gradle test" in _commands(project, ValidationCategory.UNIT_TEST)
    assert all(command.working_directory == "service" for command in project.validation_plan)


# 功能：识别 C 与 C++ 的 CMake 项目、依赖管理器和分层验证策略。
# 设计：同时放置 C/C++ 源码、CTest、clang 配置和 vcpkg 清单，保证语言结论由构建文件与目录信号共同支撑。
def test_detects_c_and_cpp_cmake_profile_and_validation_layers(tmp_path: Path) -> None:
    (tmp_path / "CMakeLists.txt").write_text(
        """
cmake_minimum_required(VERSION 3.24)
project(native LANGUAGES C CXX)
find_package(GTest REQUIRED)
enable_testing()
add_test(NAME integration_native COMMAND native)
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.cpp").write_text("int main() { return 0; }\n", encoding="utf-8")
    (tmp_path / "src" / "legacy.c").write_text("int legacy(void) { return 0; }\n", encoding="utf-8")
    (tmp_path / ".clang-format").write_text("BasedOnStyle: LLVM\n", encoding="utf-8")
    (tmp_path / ".clang-tidy").write_text("Checks: '*'\n", encoding="utf-8")
    (tmp_path / "vcpkg.json").write_text('{"name": "native"}\n', encoding="utf-8")

    profile = detect_project_profile(tmp_path)
    project = _project_at(profile, ".")

    assert _names(project.languages) == {"C", "C++"}
    assert "GoogleTest" in _names(project.frameworks)
    assert "vcpkg" in _names(project.package_managers)
    assert "CMake" in _names(project.build_tools)
    assert _commands(project, ValidationCategory.FORMAT)
    assert _commands(project, ValidationCategory.STATIC_CHECK)
    assert "ctest --test-dir build --output-on-failure" in _commands(
        project, ValidationCategory.UNIT_TEST
    )
    assert "ctest --test-dir build --output-on-failure -L integration" in _commands(
        project, ValidationCategory.INTEGRATION_TEST
    )
    assert "cmake -S . -B build && cmake --build build" in _commands(
        project, ValidationCategory.BUILD
    )


# 功能：避免把通用构建文件或非 Python 的 pyproject 配置误报为确定语言项目。
# 设计：分别构造 coverage、Kotlin Gradle 与无语言声明 CMake 信号，验证缺少语言语义或源码时不产生画像组件。
def test_ignores_ambiguous_manifests_without_language_evidence(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool.ruff]\n", encoding="utf-8")
    (tmp_path / "kotlin").mkdir()
    (tmp_path / "kotlin" / "build.gradle.kts").write_text(
        'plugins { kotlin("jvm") version "2.0.0" }\n',
        encoding="utf-8",
    )
    (tmp_path / "generator").mkdir()
    (tmp_path / "generator" / "CMakeLists.txt").write_text(
        "cmake_minimum_required(VERSION 3.24)\nproject(generator)\n",
        encoding="utf-8",
    )

    profile = detect_project_profile(tmp_path)

    assert profile.projects == []


# 功能：在 Monorepo 中分离父工作区和子项目的检测结果与命令归属。
# 设计：构造带根 pnpm 锁文件的 Node 工作区、Web 子包与 Python 服务，断言子包继承包管理器且每条建议仍携带自身路径。
def test_detects_monorepo_children_without_mixing_validation_commands(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "root", "private": True, "workspaces": ["apps/*", "services/*"]}),
        encoding="utf-8",
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    (tmp_path / "apps" / "web").mkdir(parents=True)
    (tmp_path / "apps" / "web" / "package.json").write_text(
        json.dumps({"name": "web", "scripts": {"lint": "eslint .", "build": "vite build"}}),
        encoding="utf-8",
    )
    (tmp_path / "services" / "api").mkdir(parents=True)
    (tmp_path / "services" / "api" / "pyproject.toml").write_text(
        """
[project]
name = "api"
dependencies = ["pytest"]

[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "services" / "api" / "tests").mkdir()

    profile = detect_project_profile(tmp_path)
    web = _project_at(profile, "apps/web")
    api = _project_at(profile, "services/api")

    assert profile.monorepo is True
    assert all(command.working_directory == "apps/web" for command in web.validation_plan)
    assert all(command.working_directory == "services/api" for command in api.validation_plan)
    assert "pnpm" in _names(web.package_managers)
    assert "pnpm run build" in _commands(web, ValidationCategory.BUILD)
    assert "pnpm run build" not in _commands(api, ValidationCategory.BUILD)
    assert "python -m build" in _commands(api, ValidationCategory.BUILD)
    assert {project.path for project in profile.projects} >= {"apps/web", "services/api"}


# 功能：忽略构建产物和依赖目录中的伪清单，并确保检测不会执行推荐命令。
# 设计：将 subprocess.run 替换为立即失败的桩，同时放置真实 Node 清单与被忽略目录，检测成功即证明只做离线读取。
def test_ignores_generated_directories_and_never_executes_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "safe", "scripts": {"build": "echo should-not-run"}}),
        encoding="utf-8",
    )
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "package.json").write_text(
        json.dumps({"name": "ignored"}), encoding="utf-8"
    )
    (tmp_path / "build").mkdir()
    (tmp_path / "build" / "CMakeLists.txt").write_text("project(ignored)\n", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "pom.xml").write_text("<project/>\n", encoding="utf-8")

    # 调用外部进程即视为失败，验证检测器仅返回建议数据。
    def fail_if_called(*args: object, **kwargs: object) -> object:
        raise AssertionError(f"unexpected command execution: {args!r} {kwargs!r}")

    monkeypatch.setattr(subprocess, "run", fail_if_called)
    profile = detect_project_profile(tmp_path)

    assert [project.path for project in profile.projects] == ["."]
    assert all(command.recommendation_only for command in profile.projects[0].validation_plan)
    assert "ignored" not in {finding.name for finding in profile.projects[0].frameworks}


# 功能：将画像渲染成紧凑工作上下文，并保留“仅建议、不自动执行”的安全边界。
# 设计：复用 Monorepo 形状的临时项目，断言上下文包含路径和建议说明而不包含原始 package script 正文。
def test_renders_compact_advisory_project_context(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "web", "scripts": {"build": "dangerous-command --all"}}),
        encoding="utf-8",
    )

    context = render_project_profile_context(detect_project_profile(tmp_path))

    assert "Detected Project Profile" in context
    assert "advisory only" in context
    assert "dangerous-command --all" not in context
    assert len(context) < 4_000
