import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { solveCaptcha } from './captcha-helper.mjs';

const api = process.env.HWFORAI_MEDIA_TEST_URL?.replace(/\/$/, '');
const mail = process.env.MAILPIT_URL?.replace(/\/$/, '');
const password = 'Media-fixture-safe-17!';
const suffix = randomUUID().slice(0, 8);

async function request(path, { cookie, method = 'GET', body, files, status = 200, raw = false } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (files !== undefined) {
    payload = new FormData();
    payload.set('data', JSON.stringify(body));
    for (const [index, file] of files.entries()) {
      payload.append('images', new Blob([file], { type: 'image/png' }), `fixture-${index}.png`);
    }
  } else if (raw) {
    headers['Content-Type'] = 'multipart/form-data';
    payload = 'This intentionally has no multipart boundary.';
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(path.startsWith('/api/v1/') ? new URL(path, api) : api + path, {
    method, headers, body: payload,
  });
  const allowed = Array.isArray(status) ? status : [status];
  if (!allowed.includes(response.status)) {
    assert.fail(`${method} ${path}: expected ${allowed.join(' or ')}, received ${response.status} ${await response.text()}`);
  }
  return response;
}

function cookie(response) {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(value, 'Login should issue a session cookie');
  return value;
}

async function login(login, password) {
  const response = await request('/auth/login', { method: 'POST', body: { login, password } });
  return { user: (await response.json()).user, cookie: cookie(response) };
}

async function anotherSeller() {
  const username = 'phototest' + suffix;
  const email = username + '@example.test';
  const auth = await request('/auth/register', {
    method: 'POST', status: 201,
    body: { username, email, password, role: 'SELLER', participantType: 'INDIVIDUAL', city: 'Томск', country: 'RU', telegram: username, captchaToken: await solveCaptcha(api) },
  });
  const { challengeId } = await auth.json();
  const inbox = await fetch(mail + '/api/v1/messages').then(response => response.json());
  const record = inbox.messages.find(message => message.To.some(to => to.Address === email));
  assert.ok(record, 'Mailpit received the second seller registration email');
  const message = await fetch(mail + '/api/v1/message/' + record.ID).then(response => response.json());
  const code = message.Text.match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  return cookie(await request('/auth/verify', { method: 'POST', body: { challengeId, code } }));
}

test('listing images are compressed, watermarked, bounded, atomic and access-controlled', {
  skip: !(api && mail) && 'Requires a disposable demo and Mailpit',
}, async t => {
  const seller = (await login('test1', 'test1')).cookie;
  const buyer = (await login('test2', 'test2')).cookie;
  const outsider = await anotherSeller();
  let admin = await login(
    process.env.HWFORAI_MEDIA_ADMIN_LOGIN || 'admin',
    process.env.HWFORAI_MEDIA_ADMIN_PASSWORD || 'admin',
  );
  if (admin.user.mustChangePassword) {
    const response = await request('/auth/credentials', {
      method: 'PATCH', cookie: admin.cookie,
      body: { currentPassword: process.env.HWFORAI_MEDIA_ADMIN_PASSWORD || 'admin', newPassword: password },
    });
    admin = { user: (await response.json()).user, cookie: cookie(response) };
  }
  const categories = await request('/categories').then(response => response.json());
  const fixture = {
    categoryId: categories.find(category => category.slug === 'gpu').id,
    title: 'Тест фотографий ' + suffix,
    description: 'Объявление для интеграционной проверки обработки фотографий.',
    availability: 'ORDER', originCountry: 'RU',
  };
  const portrait = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: 'white' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'orange' } })
    .png().toBuffer();
  const orders = count => Array.from({ length: count }, (_, fileIndex) => ({ fileIndex }));
  const create = (body, files, status = 201) => request('/listings', {
    method: 'POST', cookie: seller, body: { ...fixture, ...body }, files, status,
  }).then(response => response.json());
  let listing;
  let originalImages;
  const listingPath = () => '/listings/' + listing.id;

  await t.test('processes real bytes and shares photo authorization with listing detail', async () => {
    await request('/listings', { method: 'POST', raw: true, status: 401 });
    await request('/listings', { method: 'POST', raw: true, cookie: admin.cookie, status: 403 });
    listing = await create({ imageOrder: orders(2) }, [portrait, small]);
    originalImages = listing.images;
    assert.deepEqual(originalImages.map(({ width, height }) => [width, height]), [[500, 900], [1, 1]]);
    assert.ok(originalImages.every(image => image.url === `/api/v1/listings/${listing.id}/images/${image.id}`));
    await request(listingPath(), { method: 'PATCH', raw: true, cookie: outsider, status: 404 });
    await request('/admin' + listingPath(), { method: 'PATCH', raw: true, cookie: buyer, status: 403 });
    await request(originalImages[0].url, { status: 401 });
    await request(originalImages[0].url, { cookie: outsider, status: 404 });
    const photo = await request(originalImages[0].url, { cookie: buyer });
    assert.equal(photo.headers.get('content-type'), 'image/webp');
    assert.equal(photo.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await photo.arrayBuffer());
    assert.ok(bytes.length < portrait.length, 'WebP output should be smaller than this source JPEG');
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [500, 900, 'webp']);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.orientation, undefined);
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const untouched = data[(25 * info.width + 25) * info.channels];
    const badge = data[((info.height - 20) * info.width + info.width - 14) * info.channels];
    assert.ok(untouched > 240 && badge < 165, 'Font-free watermark is visible near the lower-right corner');
    const found = await request('/listings?' + new URLSearchParams({ q: suffix }), { cookie: buyer }).then(response => response.json());
    assert.deepEqual(found.items[0].images, originalImages);

    const transparent = await sharp({
      create: { width: 500, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const overlay = await create({ title: 'Прозрачность водяного знака ' + suffix, imageOrder: orders(1) }, [transparent]);
    const asset = await request(overlay.images[0].url, { cookie: buyer });
    const { data: pixels, info: rgba } = await sharp(Buffer.from(await asset.arrayBuffer()))
      .raw().toBuffer({ resolveWithObject: true });
    assert.equal(rgba.channels, 4);
    assert.equal(pixels[3], 0, 'Photo stays transparent outside the mark');
    let maxAlpha = 0;
    let strokePixels = 0;
    for (let index = 0; index < pixels.length; index += rgba.channels) {
      const alpha = pixels[index + 3];
      maxAlpha = Math.max(maxAlpha, alpha);
      if (pixels[index] > 160 && pixels[index + 1] > 160 && alpha > 140) strokePixels++;
    }
    assert.ok(strokePixels > 100, 'The wordmark strokes are rendered');
    assert.ok(maxAlpha >= 150 && maxAlpha <= 180, 'Both the plate and the strokes transmit the underlying image');
  });

  await t.test('enforces exact limits and rolls back the listing with a bad upload', async () => {
    const notImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>');
    const badTitle = 'Неполная публикация ' + suffix;
    await create({ title: badTitle, imageOrder: orders(2) }, [small, notImage], 400);
    await create({ imageOrder: orders(1) }, [Buffer.alloc(8 * 1024 * 1024 + 1)], 413);
    await create({ imageOrder: orders(11) }, Array(11).fill(small), [400, 413]);
    const mine = await request('/listings/mine?' + new URLSearchParams({ q: badTitle }), { cookie: seller }).then(response => response.json());
    assert.equal(mine.items.length, 0);
    const filled = await create({ title: 'Десять фотографий ' + suffix, imageOrder: orders(10) }, Array(10).fill(small));
    assert.equal(filled.images.length, 10, 'Ten files plus the data field are accepted');
    await request(listingPath(), {
      cookie: seller, method: 'PATCH', status: 400, body: { title: badTitle, imageOrder: [filled.images[0].id] },
    });
    const unchanged = await request(listingPath(), { cookie: seller }).then(response => response.json());
    assert.equal(unchanged.title, fixture.title);
    assert.deepEqual(unchanged.images, originalImages);
  });

  await t.test('keeps legacy photo data, reorders, replaces, and protects archived and frozen images', async () => {
    const legacy = await request(listingPath(), { cookie: seller, method: 'PATCH', body: { quantity: 2 } }).then(response => response.json());
    assert.deepEqual(legacy.images, originalImages);
    const swapped = await request(listingPath(), {
      cookie: seller, method: 'PATCH', body: { imageOrder: [originalImages[1].id, originalImages[0].id] },
    }).then(response => response.json());
    assert.deepEqual(swapped.images, originalImages.slice().reverse());
    const replacement = await request('/admin' + listingPath(), {
      cookie: admin.cookie, method: 'PATCH', body: { imageOrder: [{ fileIndex: 0 }, originalImages[1].id] }, files: [small],
    }).then(response => response.json());
    assert.equal(replacement.images.length, 2);
    assert.notEqual(replacement.images[0].id, originalImages[0].id);
    assert.equal(replacement.images[1].id, originalImages[1].id);
    await request(originalImages[0].url, { cookie: seller, status: 404 });
    const cover = replacement.images[0].url;
    const changeStatus = status => request('/admin' + listingPath() + '/status', {
      cookie: admin.cookie, method: 'PATCH', body: { status, reason: 'Проверка доступа к фотографиям' },
    });
    await changeStatus('FROZEN');
    await request(cover, { cookie: buyer, status: 404 });
    await request(cover, { cookie: seller });
    await request(cover, { cookie: admin.cookie });
    await changeStatus('ACTIVE');
    await request(cover, { cookie: buyer });
    await request(listingPath(), { cookie: seller, method: 'DELETE' });
    await request(cover, { cookie: buyer, status: 404 });
    await request(cover, { cookie: seller });
    const removed = await request(listingPath(), {
      cookie: seller, method: 'PATCH', body: { imageOrder: [] },
    }).then(response => response.json());
    assert.deepEqual(removed.images, []);
    await request(cover, { cookie: seller, status: 404 });
  });
});
