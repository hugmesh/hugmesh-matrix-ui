import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

// provideHttpClient(withFetch()) backs the role-tier datastore services
// (UserBffService / ModBffService), which talk to the same-origin /bff/** paths.
// When federated into the host, the host already provides HttpClient; standalone
// (`ng serve matrix`) this bootstrap supplies it.
bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideHttpClient(withFetch())],
}).catch((err) => console.error(err));
