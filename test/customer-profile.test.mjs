import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addUserScript = path.join(rootDir, 'scripts', 'add-user.mjs');
const networkAccelerationScript = path.join(rootDir, 'scripts', 'network-acceleration.mjs');

const samples = [
  {
    text: `公司名称：杭州紫红进出口有限责任公司
应用场景：美国 5m  家宽IP  外贸社媒运营  社媒/谷歌系都开一下
邮箱：644248404\\@qq.com
硬件部署我下班拿走`,
    companyName: '杭州紫红进出口有限责任公司',
    applicationScene: '美国 5m 家宽IP 外贸社媒运营 社媒/谷歌系都开一下',
    email: '644248404@qq.com',
    deploymentMode: '硬件部署我下班拿走',
    country: '美国',
    bandwidth: '5M',
  },
  {
    text: `公司名称：金华市海杰电子商务有限公司
场景：  新增一条，美国10 M tk直播
邮箱：479577122\\@qq.com
交付方式：硬件交付 地址群里`,
    companyName: '金华市海杰电子商务有限公司',
    applicationScene: '新增一条，美国10 M tk直播',
    email: '479577122@qq.com',
    deploymentMode: '硬件交付 地址群里',
    country: '美国',
    bandwidth: '10M',
  },
  {
    text: `公司名称：武汉市江岸区奶丝丝互娱文化传媒工作室(个体工商户)
场景： tk直播 台湾5M
邮箱：1353302706\\@qq.com
交付方式：软件交付`,
    companyName: '武汉市江岸区奶丝丝互娱文化传媒工作室(个体工商户)',
    applicationScene: 'tk直播 台湾5M',
    email: '1353302706@qq.com',
    deploymentMode: '软件交付',
    country: '台湾',
    bandwidth: '5M',
  },
  {
    text: `福建正弘科技有限公司
沙特5M 家宽ip  外贸社媒facebook,whatsapp，LinkedIn，谷歌
邮箱：13954524\\@qq.com
软件`,
    companyName: '福建正弘科技有限公司',
    applicationScene: '沙特5M 家宽ip 外贸社媒facebook,whatsapp，LinkedIn，谷歌',
    email: '13954524@qq.com',
    deploymentMode: '软件',
    country: '沙特',
    bandwidth: '5M',
  },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('customer profile recognition accepts field aliases and free-form customer text', async () => {
  for (const sample of samples) {
    const { stdout } = await execFileAsync(process.execPath, [
      addUserScript,
      '--text',
      sample.text,
      '--dry-run-parse',
    ], { cwd: rootDir });

    assert.match(stdout, new RegExp(`公司名称：${escapeRegExp(sample.companyName)}`));
    assert.match(stdout, new RegExp(`应用场景：${escapeRegExp(sample.applicationScene)}`));
    assert.match(stdout, new RegExp(`邮箱：${escapeRegExp(sample.email)}`));
    assert.match(stdout, new RegExp(`部署方式：${escapeRegExp(sample.deploymentMode)}`));
  }
});

test('network acceleration recognition accepts scene aliases and new regions', async () => {
  for (const sample of samples) {
    const { stdout } = await execFileAsync(process.execPath, [
      networkAccelerationScript,
      '--text',
      sample.text,
      '--dry-run-parse',
    ], { cwd: rootDir });

    assert.match(stdout, new RegExp(`公司名称：${escapeRegExp(sample.companyName)}`));
    assert.match(stdout, new RegExp(`加速类型：${escapeRegExp(sample.country)} ${escapeRegExp(sample.bandwidth)}`));
    assert.match(stdout, new RegExp(`IP地区：${escapeRegExp(sample.country)}`));
    assert.match(stdout, new RegExp(`套餐：基础版-${escapeRegExp(sample.bandwidth)}`));
  }
});
