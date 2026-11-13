import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocumentBertCondition } from '../server/document-bert-query.js';

const query = '找总次数不少于20次的计划申请单';
const model = {
  labels: {
    planTotal: {kind: '计划申请单', label: '总次数', operators: ['gte']},
    afterTotal: {kind: '后装申请单', label: '总次数', operators: ['gte']},
  },
  async predict() {
    return {intent: 'FILTER1', confidence: .99, fields: [{field: 'planTotal_gte', text: '20'}]};
  },
};

test('第四轮单条件使用确认后的单据类型、字段、数值和比较符', async () => {
  assert.deepEqual(await parseDocumentBertCondition(query, () => model), {
    type: '计划申请单', conditions: [{label: '总次数', operator: 'gte', value: '20'}],
  });
  const afterModel = { ...model, async predict() {
    return {intent: 'FILTER1', confidence: .99, fields: [{field: 'afterTotal_gte', text: '20'}]};
  } };
  assert.equal(await parseDocumentBertCondition(query, () => afterModel), 'review');
});

test('跳过缺类型并在取值核验后拒绝多个条件', async () => {
  const unexpected = () => assert.fail('不应调用模型');
  assert.equal(await parseDocumentBertCondition('靶区部位是头部', unexpected), undefined);
  for (const input of ['找总次数为20且总次数不少于19的计划申请单',
    '找扫描部位是胸部以及固定部位是头部的复位申请单']) {
    assert.equal(await parseDocumentBertCondition(input, () => model), 'review');
  }
  assert.equal(await parseDocumentBertCondition('胸部', unexpected), undefined);
});

test('第四轮将模型文件缺失和推理失败标记为不可用', async () => {
  assert.equal(await parseDocumentBertCondition(query, () => undefined), 'unavailable');
  assert.equal(await parseDocumentBertCondition(query, () => ({ ...model, predict: async () => null })), 'unavailable');
});

test('字段值可以和字段名相同', async () => {
  const candidate = {
    labels: { order: { kind: '计划申请单', label: '补充医嘱', operators: ['contains'] } },
    async predict() {
      return { intent: 'FILTER1', confidence: .99, fields: [{ field: 'order_contains', text: '补充医嘱' }] };
    },
  };
  assert.deepEqual(await parseDocumentBertCondition('找补充医嘱包含补充医嘱的计划申请单', () => candidate), {
    type: '计划申请单', conditions: [{ label: '补充医嘱', operator: 'contains', value: '补充医嘱' }],
  });
});
