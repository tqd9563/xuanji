import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /**
     * 远程访问相关变量一律清空:测试进程可能从宿主环境继承到真实口令
     * (派发会话就是璇玑后端的子进程),不钉死的话用例结果会随本机部署状态漂移。
     * 需要这些值的用例自己用 vi.stubEnv 显式设置。
     */
    env: {
      XUANJI_ENV_FILE: 'none',
      XUANJI_HOST: '',
      XUANJI_PASSWORD: '',
      XUANJI_CONFIRM_TOKEN: '',
      XUANJI_CONFIRM_SCOPE: '',
      XUANJI_TLS_CERT: '',
      XUANJI_TLS_KEY: '',
      XUANJI_REMOTE_PORT: '',
      XUANJI_PORT: '',
      XUANJI_TRUST_LOOPBACK: '',
    },
  },
});
