import { describe, expect, it } from 'vitest';
import { isBtwText, parseBtw, pinText } from './btw';

describe('/btw 文本约定', () => {
  it('识别前缀:大小写不敏感、允许前导空白、必须是独立单词', () => {
    expect(isBtwText('/btw 这是什么')).toBe(true);
    expect(isBtwText('  /BTW x')).toBe(true);
    expect(isBtwText('/btwx')).toBe(false);
    expect(isBtwText('说 /btw 不算')).toBe(false);
    expect(isBtwText('')).toBe(false);
  });

  it('解析问题:只有前缀 → 空问题(打开面板);非旁路 → null', () => {
    expect(parseBtw('/btw')).toEqual({ question: '' });
    expect(parseBtw('/btw   ')).toEqual({ question: '' });
    expect(parseBtw('/btw  wall-on 和 wall-glass 区别?')).toEqual({ question: 'wall-on 和 wall-glass 区别?' });
    expect(parseBtw('普通消息')).toBeNull();
  });

  it('钉入主对话的正文带问与答', () => {
    expect(pinText('q', ' a \n')).toBe('之前旁路问过:q\n结论:a');
  });
});
