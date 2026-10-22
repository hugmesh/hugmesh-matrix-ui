// Required by karma.conf.js; loads recursively all the .spec and framework files.
import 'zone.js/testing';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// Legacy read-fallback generations (see app/legacy-read.ts): the specs walk the
// full three-generation chain, so give the injected pre-rebrand brand hook the
// public placeholder stem. Set here, before any spec imports legacy-read.ts —
// the lists are built when that module first loads, as in production.
(globalThis as Record<string, unknown>)['__HUG_LEGACY_EVENT_BRANDS__'] = ['exampleorg'];

// Initialize the Angular testing environment.
getTestBed().initTestEnvironment(
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting(),
);
