# AGENTS.md

- 实施与独立评审分离；本项目由实施者完成，评审者独立检查。
- 测试只运行 `npm test` 和 `npm run check`。
- 测试必须使用临时 `DATA_DIR` 与 `127.0.0.1` 随机端口，禁止触碰真实存储或常驻服务。
- 实施者不 commit、不 push、不部署；主评审可按用户当前明确授权提交、创建 GitHub public 仓库并推送。
