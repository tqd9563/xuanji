import { describe, expect, it } from 'vitest';
import { completionName, filterCmds, nameParts, slashQuery, splitCommand, type SlashCmd } from './slash';

const cmd = (name: string, kind: SlashCmd['kind'] = 'skill'): SlashCmd => ({ name, desc: '', arg: '', kind });

describe('slashQuery', () => {
  it('以斜杠开头且尚无空白时给出查询词', () => {
    expect(slashQuery('/bai')).toBe('bai');
    expect(slashQuery('/')).toBe('');
  });

  it('敲下第一个空格即视为命令已选定,不再联想', () => {
    expect(slashQuery('/baize ')).toBeNull();
    expect(slashQuery('/baize 今天的 DAU')).toBeNull();
  });

  it('不以斜杠开头、或斜杠不在最前面都不联想', () => {
    expect(slashQuery('帮我 /baize')).toBeNull();
    expect(slashQuery('')).toBeNull();
    expect(slashQuery('\n/baize')).toBeNull();
  });

  it('查询词统一小写,免得调用方各自处理大小写', () => {
    expect(slashQuery('/Lark')).toBe('lark');
  });
});

describe('filterCmds', () => {
  const list = [cmd('baize'), cmd('baize-issue'), cmd('watch:watch'), cmd('lark-doc'), cmd('agent-browser')];

  it('空查询交出全部,顺序不变', () => {
    expect(filterCmds('', list).map((c) => c.name)).toEqual(list.map((c) => c.name));
  });

  it('全名前缀排在短名前缀之前,短名前缀排在子串之前', () => {
    expect(filterCmds('watch', [cmd('rewatch-x'), cmd('watch:watch'), cmd('x:watchdog')]).map((c) => c.name)).toEqual([
      'watch:watch',
      'x:watchdog',
      'rewatch-x',
    ]);
  });

  it('插件技能靠短名也能搜到:用户记得的是 /watch 不是 /watch:watch', () => {
    expect(filterCmds('wat', list).map((c) => c.name)).toEqual(['watch:watch']);
  });

  it('不做子序列匹配:命令名是手敲得出的短标识,散点命中只会把无关项拉进来', () => {
    expect(filterCmds('bze', list)).toEqual([]);
  });

  it('同层保持入参顺序(后端已按名排好)', () => {
    expect(filterCmds('baize', list).map((c) => c.name)).toEqual(['baize', 'baize-issue']);
  });
});

describe('completionName', () => {
  const list = [cmd('watch:watch'), cmd('lark-doc'), cmd('a:dup'), cmd('b:dup')];

  it('短名唯一时补短名,与用户在终端里的手感一致', () => {
    expect(completionName('watch:watch', list)).toBe('watch');
  });

  it('短名有歧义时退回全名,免得补出一个错命令', () => {
    expect(completionName('a:dup', list)).toBe('a:dup');
  });

  it('本就没有插件前缀的原样返回', () => {
    expect(completionName('lark-doc', list)).toBe('lark-doc');
  });
});

describe('splitCommand', () => {
  const names = new Set(['baize', 'watch', 'wrapup']);

  it('完整命中后切出命令词,供镜像层单独上色', () => {
    expect(splitCommand('/baize', names)).toEqual({ cmd: '/baize', rest: '' });
    expect(splitCommand('/baize 今天的 DAU', names)).toEqual({ cmd: '/baize', rest: ' 今天的 DAU' });
  });

  it('只是前缀相同不算命中:/baizex 不是 /baize', () => {
    expect(splitCommand('/baizex', names)).toBeNull();
  });

  it('未知命令不着色', () => {
    expect(splitCommand('/zzz', names)).toBeNull();
  });

  it('换行后的内容照样算参数,多行消息的第一行仍着色', () => {
    expect(splitCommand('/wrapup\n补充说明', names)).toEqual({ cmd: '/wrapup', rest: '\n补充说明' });
  });

  it('不以斜杠开头的普通消息不参与', () => {
    expect(splitCommand('帮我看下 /baize', names)).toBeNull();
    expect(splitCommand('/', names)).toBeNull();
  });
});

describe('nameParts', () => {
  it('切出连续命中片段供候选行加粗已输入的前缀', () => {
    expect(nameParts('baize-issue', 'baize')).toEqual({ before: '', hit: 'baize', after: '-issue' });
  });

  it('命中在中段时前后都保留', () => {
    expect(nameParts('watch:watch', 'tch')).toEqual({ before: 'wa', hit: 'tch', after: ':watch' });
  });

  it('空查询或未命中时整串当作未高亮部分', () => {
    expect(nameParts('baize', '')).toEqual({ before: 'baize', hit: '', after: '' });
    expect(nameParts('baize', 'zz')).toEqual({ before: 'baize', hit: '', after: '' });
  });
});
