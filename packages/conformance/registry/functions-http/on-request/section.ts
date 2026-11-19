import { defineRowSection } from '../../section-rows.ts';
import { bindFunctionsHttpRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-http',
  order: 10,
  prefix: '## `onRequest` serving, request, and response contract\n',
  defaults: {
    section: '`firebase-functions/v2/https.onRequest`',
    featureKeys: ['onRequest'],
  },
});

export const row = bindFunctionsHttpRow(section);
