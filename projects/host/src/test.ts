// Required by karma.conf.js; loads recursively all the .spec and framework files.
// Mirrors projects/matrix/src/test.ts — the host project previously had NO test
// architect target at all (a pre-existing infra gap); this is the minimal setup
// needed to karma-test the SessionService/guard/nav logic added here.
import 'zone.js/testing';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

// Initialize the Angular testing environment.
getTestBed().initTestEnvironment(
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting(),
);
