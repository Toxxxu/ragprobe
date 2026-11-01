import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatasetError } from '../src/core/errors.js';
import { parseDataset } from '../src/dataset/load.js';

describe('parseDataset', () => {
  it('parses valid lines and skips blanks and comments', () => {
    const cases = parseDataset(
      [
        '# comment',
        '{"id":"a","question":"Q1?","relevantDocIds":["d1","d1","d2"],"tags":["x"]}',
        '',
        '{"id":"b","question":"Q2?","relevantDocIds":["d3"],"referenceAnswer":"A"}',
      ].join('\n'),
    );
    assert.equal(cases.length, 2);
    assert.deepEqual(cases[0]?.relevantDocIds, ['d1', 'd2'], 'dedupes relevant ids');
    assert.equal(cases[1]?.referenceAnswer, 'A');
    assert.equal('referenceAnswer' in (cases[0] ?? {}), false, 'omits absent optional fields');
  });

  it('reports every issue with its line number', () => {
    const text = [
      '{"id":"a","question":"Q?","relevantDocIds":["d"]}',
      'not json',
      '{"id":"","question":"Q?","relevantDocIds":[]}',
      '{"id":"a","question":"Again?","relevantDocIds":["d"]}',
    ].join('\n');

    assert.throws(
      () => parseDataset(text, 'bad.jsonl'),
      (err: unknown) => {
        assert.ok(err instanceof DatasetError);
        assert.deepEqual(
          err.issues.map((i) => i.line),
          [2, 3, 3, 4],
        );
        assert.match(err.message, /duplicate id "a" \(first seen on line 1\)/);
        return true;
      },
    );
  });

  it('rejects an empty dataset', () => {
    assert.throws(() => parseDataset('# nothing here\n'), DatasetError);
  });
});
