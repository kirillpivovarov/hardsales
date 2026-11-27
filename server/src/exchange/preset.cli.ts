import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AppModule } from '../app.module';
import { DatabaseService } from '../database/database.service';
import { currencies } from '../market/market.inputs';
import { TrialPreset } from '../ops/trial-preset';

async function main() {
  const [preset, flag, username] = process.argv.slice(2);
  if (preset !== 'trial' || flag !== '--admin' || !username || process.argv.length !== 5 || !stdin.isTTY) {
    throw new Error('Используйте интерактивный терминал: node dist/exchange/preset.cli.js trial --admin <логин>');
  }
  const readline = createInterface({ input: stdin, output: stdout });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'], abortOnError: false });
  try {
    const db = app.get(DatabaseService);
    const { rows: [actor] } = await db.query<{ id: string; username: string; role: 'ADMIN' }>(`
      SELECT id,username,role FROM users WHERE lower(username)=lower($1) AND role='ADMIN' AND status='ACTIVE'
        AND email_verified_at IS NOT NULL AND NOT must_change_password
    `, [username]);
    if (!actor) throw new Error('Действующая учётная запись администратора не найдена');
    const trial = app.get(TrialPreset);
    const preview = await trial.preview();
    const rates: Record<string, unknown> = {};
    const failed = preview.checks.filter(check => check.id !== 'rates' && !check.ok);
    if (failed.length) throw new Error(failed.map(check => check.text).join('\n'));
    for (const currency of currencies) {
      const previous = preview.fxRates[currency];
      const input = await readline.question(`Курс ${currency} в USD${previous ? ' [' + previous + ']' : ''}: `);
      rates[currency] = input.trim() || previous;
    }
    const proposed = await trial.preview(rates);
    if (!proposed.checks.every(check => check.ok)) throw new Error('Укажите действительные курсы всех валют');
    console.table(proposed.changes);
    console.log('Первый вопрос об актуальности: ' + proposed.firstActualityAt.toISOString());
    if ((await readline.question('Введите trial для применения: ')).trim() !== 'trial') {
      console.log('Применение отменено.');
      return;
    }
    const applied = await trial.apply(actor, rates);
    console.log(`Пресет применён. Номер записи: ${applied.presetRunId}`);
  } finally {
    readline.close();
    await app.close();
  }
}
void main().catch(cause => {
  console.error(cause instanceof Error ? cause.message : 'Не удалось применить пресет');
  process.exitCode = 1;
});
