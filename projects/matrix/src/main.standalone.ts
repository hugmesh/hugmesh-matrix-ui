import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { StandaloneShellComponent } from './app/standalone/standalone-shell.component';
import { routes } from './app/app.routes';

// Standalone deployment (hugmesh-tuwunel-web in front of Tuwunel): no host shell and no module federation. The routes are
// the same MATRIX_ROUTES the host mounts, here at the site root.
bootstrapApplication(StandaloneShellComponent, {
  providers: [provideRouter(routes), provideHttpClient(withFetch())],
}).catch((err) => console.error(err));
