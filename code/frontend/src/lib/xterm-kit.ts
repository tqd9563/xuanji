/**
 * xterm.js 与终端字体的懒加载入口:只在第一次需要终端(呼出 / 页面刷新时接回存活会话)时加载,
 * 不进主包——它有约 390KB,而多数时候终端是收着的。
 */
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

export { Terminal } from '@xterm/xterm';
export { FitAddon } from '@xterm/addon-fit';
export { Unicode11Addon } from '@xterm/addon-unicode11';
export { WebLinksAddon } from '@xterm/addon-web-links';
