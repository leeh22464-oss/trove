import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSkill, sanitizeName, buildSkillMd, parseFrontmatter } from '../src/skill.js';

const good = `---
name: pdf-reader
description: "Extracts text from PDF files when the user needs to read or summarize a PDF document."
---

# PDF Reader

Instructions here.
`;

test('合法 skill 无 errors', () => {
  const { errors } = validateSkill(good);
  assert.equal(errors.length, 0);
});

test('缺 frontmatter 报错', () => {
  const { errors } = validateSkill('# no frontmatter');
  assert.ok(errors.some(e => e.field === 'frontmatter'));
});

test('name 大写 / 非法字符 / 连字符边界 / 连续连字符 / 保留词', () => {
  const cases = [
    ['My-Skill', /全小写/],
    ['my skill', /只能包含/],
    ['-skill', /开头或结尾/],
    ['skill-', /开头或结尾/],
    ['my--skill', /连续连字符/],
    ['claude-helper', /保留词/],
    ['a'.repeat(65), /64/],
  ];
  for (const [name, re] of cases) {
    const { errors } = validateSkill(`---\nname: ${name}\ndescription: "Does something useful when needed by the user."\n---\nx`);
    assert.ok(errors.some(e => re.test(e.message)), `${name}: ${JSON.stringify(errors)}`);
  }
});

test('description 缺失 / 过长 / 过短 warning', () => {
  const e1 = validateSkill('---\nname: ok-name\n---\nx');
  assert.ok(e1.errors.some(e => e.field === 'description'));
  const w = validateSkill(`---\nname: ok-name\ndescription: "Short"\n---\nx`);
  assert.ok(w.warnings.some(w => /过短/.test(w.message)));
  const long = validateSkill(`---\nname: ok-name\ndescription: "${'x'.repeat(1100)}"\n---\nx`);
  assert.ok(long.errors.some(e => /1024/.test(e.message)));
});

test('自动修复建议', () => {
  const { fixes } = validateSkill('---\nname: My--Skill\ndescription: "x"\n---\ny');
  assert.ok(fixes.some(f => /my-skill|myskill/.test(f.suggestion) || f.suggestion));
});

test('sanitizeName', () => {
  assert.equal(sanitizeName('My Cool Skill!'), 'my-cool-skill');
  assert.equal(sanitizeName('claude-thing'), 'thing');
});

test('buildSkillMd 输出可再次解析', () => {
  const md = buildSkillMd({ name: 'X', description: 'test desc when needed', body: 'body' });
  const { attrs, errors } = { attrs: parseFrontmatter(md).attrs, errors: validateSkill(md).errors };
  assert.equal(attrs.name, 'x');
  assert.equal(errors.length, 0);
});
