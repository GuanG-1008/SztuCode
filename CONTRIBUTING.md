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
npm install
npm run typecheck
npm test
npm run build
npm run docs:protocol
npm run docs:links
```

只有修改 legacy Python 客户端、兼容 fixture 或专业 artifact 脚本时，才需要额外运行对应的 `uv`、Ruff、mypy 与 pytest 检查。
