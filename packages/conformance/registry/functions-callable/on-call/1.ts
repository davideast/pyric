import { row } from './section.ts';

export default row({
  order: 10,
  kind: 'observed',
  api: 'onCall(handler): {data} and {result}',
  behavior:
    'A POST of {"data": x} reaches v2 request.data (v1: the data argument) for every JSON value kind, and the return value answers 200 application/json {"result": value}. A handler that returns null or undefined answers {"result": null}.',
  evidence:
    'upstream: `wrapOnCallHandler` decodes `req.body.data` and answers `res.status(200).send({ result })` (`:462`, `:516-524`); `encode` maps null and undefined to null (`:164-167`). Production behavior needs `functions-callable-data-roundtrip`.',
});
