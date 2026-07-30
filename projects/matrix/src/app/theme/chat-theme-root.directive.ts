import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';
import { ChatThemeService } from './chat-theme.service';

/**
 * Marks a routed shell component's HOST ELEMENT as a chat-theme root: the
 * element {@link ChatThemeService} stamps the `data-matrix-*` attributes and
 * `--hugm-chat-*` custom properties onto.
 *
 * Attached via `hostDirectives` on the remote's routed shells (chat shell,
 * room view, thread panel, user settings) because when federated this remote
 * has NO persistent root of its own — the host mounts MATRIX_ROUTES straight
 * into its router outlet. Scoping the theme to these hosts (instead of
 * `<body>`/`<html>`) is what keeps it from leaking into the host shell or the
 * other federated remotes; the CSS custom properties inherit DOWN into the
 * timeline/composer children, exactly like the scoped rules in
 * styles/_chat-themes.scss expect.
 */
@Directive({
  selector: '[hugChatThemeRoot]',
  standalone: true,
})
export class ChatThemeRootDirective implements OnInit, OnDestroy {
  private readonly theme = inject(ChatThemeService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  ngOnInit(): void {
    this.theme.registerRoot(this.el.nativeElement);
  }

  ngOnDestroy(): void {
    this.theme.unregisterRoot(this.el.nativeElement);
  }
}
