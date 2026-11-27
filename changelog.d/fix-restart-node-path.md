### 修复

- **部署脚本**：`restart.sh` 改用与常驻后端相同的 Node(读取 launchd plist 中的 node 路径),终端 nvm 默认版本没装 pnpm 时不再报 `pnpm: command not found`,依赖安装也不会按另一个 Node 的 ABI 编译 native 模块
