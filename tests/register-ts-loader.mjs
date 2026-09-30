import { register } from 'node:module';

register('./ts-resolver.mjs', new URL('./', import.meta.url));
