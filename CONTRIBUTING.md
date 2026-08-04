# 贡献 SztuCode

完整贡献流程见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

开始贡献前，请阅读：

- [社区行为准则](docs/CODE_OF_CONDUCT.md)
- [项目路线图](docs/ROADMAP.md)
- [安全政策](docs/SECURITY.md)
- [开发环境](docs/development/development.md)
- [测试指南](docs/development/testing.md)

快速检查：

```bash
uv sync
uv run ruff check src tests scripts
uv run mypy src
uv run pytest tests/unit -v
uv run python scripts/gen_protocol_doc.py --check
```
