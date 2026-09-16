/**
 * 从 MCP 工具结果文件里提取 base64 并解码成二进制。
 *
 * 背景：本机网络不通时，GitHub MCP 通道仍然可用 —— 它把二进制文件
 * 以 base64 形式落到工具结果文件里。这个脚本把它还原成真正的文件。
 *
 * 用法：node tools/extract-b64.mjs <结果文件> <输出文件>
 * （结果文件形如 [{type:'text',...},{type:'resource',resource:{text:'<base64>'}}]）
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error('用法: node tools/extract-b64.mjs <结果文件> <输出文件>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(src, 'utf8'));
const blocks = Array.isArray(raw) ? raw : [raw];

const res = blocks.find(b => b?.type === 'resource')?.resource
  ?? blocks.find(b => b?.resource?.blob || b?.resource?.text)?.resource;

// 二进制走 blob，文本走 text —— 两种都要认
const b64 = String(res?.blob ?? res?.text ?? '').replace(/\s+/g, '');

if (!b64) {
  const keys = res ? Object.keys(res).join(', ') : '无 resource 对象';
  console.error(`结果文件里没有 base64 内容（有的字段：${keys}）`);
  process.exit(1);
}

const buf = Buffer.from(b64, 'base64');
writeFileSync(dest, buf);
console.log(`已写出 ${dest}：${buf.length} 字节`);
