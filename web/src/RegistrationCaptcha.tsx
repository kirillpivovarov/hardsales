import { useEffect, useRef } from 'react';
import 'altcha/external';
import 'altcha/altcha.css';
import 'altcha/i18n/ru';
import type {} from 'altcha/types/react';
import CaptchaWorker from 'altcha/workers/pbkdf2?worker';
import { useI18n } from './i18n';

globalThis.$altcha.algorithms.set('PBKDF2/SHA-256', () => new CaptchaWorker());
globalThis.$altcha.defaults.set({
  hideFooter: true,
  hideLogo: true,
  humanInteractionSignature: false,
});

const messages = {
  label: 'Я не робот',
  loading: 'Загружаем проверку CAPTCHA…',
  verified: 'Проверка пройдена',
  verifying: 'Проверяем…',
  waitAlert: 'Проверяем… Подождите.',
  error: 'Проверка не удалась. Повторите попытку.',
  expired: 'Срок проверки истёк. Повторите попытку.',
  reload: 'Повторить проверку',
  verificationRequired: 'Пройдите проверку CAPTCHA.',
};

interface CaptchaState {
  state: string;
  payload?: string;
}

export default function RegistrationCaptcha({ onToken }: { onToken: (token: string | undefined) => void }) {
  const { locale, t } = useI18n();
  const language = locale.toLowerCase();
  const ref = useRef<HTMLElementTagNameMap['altcha-widget']>(null);

  useEffect(() => {
    const widget = ref.current;
    if (!widget) return;
    const strings = Object.fromEntries(Object.entries(messages).map(([key, source]) => [key, t(source)]));
    globalThis.$altcha.i18n.set(language, { ...globalThis.$altcha.i18n.get('ru'), ...strings, footer: '' });
    function onStateChange(event: Event) {
      const { state, payload } = (event as CustomEvent<CaptchaState>).detail;
      onToken(state === 'verified' ? payload : undefined);
    }
    widget.addEventListener('statechange', onStateChange);
    let active = true;
    // ALTCHA exposes its methods after its asynchronous connectedCallback creates the widget.
    void customElements.whenDefined('altcha-widget').then(() => {
      if (active && widget.isConnected) return widget.configure?.({ formatError: () => t(messages.error) });
    });
    return () => {
      active = false;
      widget.removeEventListener('statechange', onStateChange);
    };
  }, [language, onToken, t]);

  return <altcha-widget ref={ref} challenge="/api/v1/auth/captcha" language={language} workers={1} />;
}
