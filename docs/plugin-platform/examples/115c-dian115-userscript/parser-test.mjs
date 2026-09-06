import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./dian115-p115c.user.js', import.meta.url), 'utf8')
const gmRequests = []
const gmResponses = []
const context = {
  __D115_TEST__: true,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams,
  console,
  document: {
    createElement: () => ({ innerHTML: '', value: '' }),
    readyState: 'loading', addEventListener() {},
  },
  location: { href: 'https://example.invalid/', protocol: 'https:', hostname: 'example.invalid' },
  GM_getValue: () => ({
    cookie: 'UID=test; CID=test; SEID=test;',
    dian115Base: 'https://dian.example',
    openApiKey: 'openapi-secret',
  }),
  GM_setValue() {}, GM_addStyle() {}, GM_registerMenuCommand() {},
  GM_xmlhttpRequest(request) {
    gmRequests.push(request)
    request.onload(gmResponses.shift() || { status: 200, responseText: '{"state":true,"data":[]}' })
  },
}
context.globalThis = context
vm.runInNewContext(source, context, { filename: 'dian115-p115c.user.js' })
const api = context.__D115_TEST_API__
assert.ok(api, 'test API was not exported')
assert.doesNotMatch(source, /anonymous:\s*true/)
assert.doesNotMatch(source, /APP_VERSION|RSA_|LONG_KEY|p115Xor|p115Encrypt|p115Decrypt|lixianssp|allowEncrypted/)
assert.match(source, /@name\s+115 转存离线助手/)
assert.match(source, /@author\s+yamcv98/)
assert.doesNotMatch(source, /autoUnlockFree|autoUnlockPaid|解锁后转存|解锁后离线/)
assert.match(source, /source: PUSH_SOURCE/)
assert.match(source, /const PUSH_SOURCE = '转存助手'/)
assert.match(source, /await sleep\(500\)/)
assert.match(source, /https:\/\/github\.com\/madbrolab\/dian115/)
assert.match(source, /https:\/\/115\.com\/favicon\.ico/)
assert.match(source, /DIAN115 订阅列表/)
assert.match(source, /\/api\/openapi\/v1\/subscriptions/)
assert.match(source, /https:\/\/hdhive\.com/)
assert.match(source, /extractCandidates\(location\.href\)/)
assert.match(source, /addEventListener\('popstate', scheduleScan\)/)
assert.match(source, /d115-detected-icon/)
assert.match(source, /https:\/\/webapi\.115\.com/)
assert.match(source, /https:\/\/115cdn\.com\/webapi\/share\/snap/)
assert.match(source, /https:\/\/115cdn\.com\/webapi\/share\/receive/)

await api.list115Dirs('0')
const directoryRequest = gmRequests.shift()
assert.equal(directoryRequest.method, 'GET')
assert.equal(directoryRequest.url, 'https://webapi.115.com/files?aid=1&cid=0&show_dir=1&nsprefix=1')
assert.equal(directoryRequest.headers.Cookie, 'UID=test; CID=test; SEID=test;')
assert.equal(directoryRequest.headers['User-Agent'], 'Mozilla/5.0')
assert.equal('anonymous' in directoryRequest, false)
assert.equal('cookie' in directoryRequest, false)

await api.listShareFiles({ shareCode: 'Share987', receiveCode: 'k9x2' })
const snapRequest = gmRequests.shift()
assert.equal(snapRequest.url.startsWith('https://115cdn.com/webapi/share/snap?'), true)
assert.equal(snapRequest.headers.Referer, 'https://115.com/')
assert.equal(snapRequest.headers.Origin, 'https://115.com')

await api.receiveShare({ shareCode: 'Share987', receiveCode: 'k9x2' }, ['file-1'], '123')
const receiveRequest = gmRequests.shift()
assert.equal(receiveRequest.url, 'https://115cdn.com/webapi/share/receive')
assert.equal(receiveRequest.method, 'POST')
assert.equal(receiveRequest.data.includes('file_id=file-1'), true)
assert.equal(receiveRequest.data.includes('cid=123'), true)

gmResponses.push(
  { status: 200, responseText: '{"state":true,"sign":"sig-test","time":"1700000000"}' },
  { status: 200, responseText: '{"state":true,"user_id":"uid-test"}' },
  { status: 200, responseText: '{"state":true,"name":"queued"}' },
)
await api.p115Offline(['magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'], '456')
const offlineSpaceRequest = gmRequests.shift()
const offlineUploadRequest = gmRequests.shift()
const offlineSubmitRequest = gmRequests.shift()
assert.equal(offlineSpaceRequest.url.startsWith('https://115.com/?ct=offline&ac=space&_='), true)
assert.equal(offlineUploadRequest.url, 'https://proapi.115.com/app/uploadinfo')
assert.equal(offlineSubmitRequest.url, 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url')
assert.equal(offlineSubmitRequest.method, 'POST')
assert.equal(offlineSubmitRequest.data.includes('uid=uid-test'), true)
assert.equal(offlineSubmitRequest.data.includes('sign=sig-test'), true)
assert.equal(offlineSubmitRequest.data.includes('time=1700000000'), true)
assert.equal(offlineSubmitRequest.data.includes('wp_path_id=456'), true)
assert.equal(offlineSubmitRequest.data.includes('url=magnet%3A%3Fxt%3Durn%3Abtih%3A0123456789abcdef0123456789abcdef01234567'), true)

gmResponses.push({ status: 200, responseText: '{"state":true,"name":"queued"}' })
await api.p115Offline(['https://example.com/movie.torrent'], '456')
const directUrlRequest = gmRequests.shift()
assert.equal(directUrlRequest.url, 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url')
assert.equal(directUrlRequest.data.includes('url=https%3A%2F%2Fexample.com%2Fmovie.torrent'), true)

gmResponses.push({
  status: 200,
  responseText: JSON.stringify({
    code: 'ok',
    data: {
      subscriptions: [{ tmdb_id: 550, media_type: 'movie', title: 'Fight Club', status: 'active' }],
      total: 1, limit: 100, offset: 0, has_more: false,
    },
  }),
})
const subscriptions = await api.listDian115Subscriptions()
const subscriptionsRequest = gmRequests.shift()
assert.equal(subscriptionsRequest.url, 'https://dian.example/api/openapi/v1/subscriptions?limit=100&offset=0')
assert.equal(subscriptionsRequest.headers['X-OpenAPI-Key'], 'openapi-secret')
assert.equal(subscriptions.items[0].tmdb_id, 550)
assert.equal(api.buildHdhiveUrl(subscriptions.items[0]), 'https://hdhive.com/tmdb/movie/550')
assert.equal(api.buildTmdbUrl(subscriptions.items[0]), 'https://www.themoviedb.org/movie/550')
assert.equal(api.buildHdhiveUrl({ tmdb_id: 123, media_type: 'tv' }), 'https://hdhive.com/tmdb/tv/123')
assert.equal(api.buildTmdbUrl({ tmdb_id: 123, media_type: 'tv' }), 'https://www.themoviedb.org/tv/123')
assert.equal(api.buildHdhiveUrl({ tmdb_id: 0, media_type: 'movie' }), '')
assert.equal(api.buildTmdbUrl({ tmdb_id: 0, media_type: 'movie' }), '')
const anchorRect = { left: 200, right: 400, top: 100, bottom: 130, width: 200, height: 30 }
const nativeOpenButton = { left: 408, right: 490, top: 90, bottom: 140 }
assert.equal(api.rectsOverlap({ left: 408, right: 480, top: 95, bottom: 135 }, nativeOpenButton, 3), true)
const safePlacement = api.chooseActionPlacement(anchorRect, 70, 28, 800, 600, [nativeOpenButton])
assert.equal(safePlacement.name, 'left')
const fallbackPlacement = api.chooseActionPlacement(anchorRect, 70, 28, 800, 600, [
  { left: 0, right: 800, top: 0, bottom: 600 },
])
assert.ok(fallbackPlacement)
assert.equal(fallbackPlacement.fallback, true)

const plain = value => JSON.parse(JSON.stringify(value))

assert.deepEqual(plain(api.parse115Share('https://115.com/s/AbC123?password=pwd9')), {
  type: 'share115', raw: 'https://115.com/s/AbC123?password=pwd9', shareCode: 'AbC123', receiveCode: 'pwd9',
})
assert.equal(api.parse115Share('https://example.com/s/AbC123'), null)
assert.deepEqual(plain(api.parse115Cid('115CID:123')), { type: 'cid115', raw: '115CID:123', cid: '123' })
assert.equal(api.parse115Cid('115CID=456').cid, '456')
assert.equal(api.parse115Cid('115cid://789').cid, '789')
assert.equal(api.parse115Cid('https://115.com/?cid=321').cid, '321')
assert.equal(api.parse115Cid('https://example.com/?cid=321'), null)
assert.equal(api.canonicalOffline('MAGNET:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567').type, 'magnet')
assert.equal(api.canonicalOffline('ed2k://|file|movie.mkv|1|ABCDEF0123456789ABCDEF0123456789|/').type, 'ed2k')
assert.equal(api.canonicalOfflineAddress('https://example.com/movie.torrent').type, 'offlineUrl')
assert.equal(api.canonicalOfflineAddress('https://115.com/s/abc123'), null)
assert.deepEqual(
  plain(api.extractManualCandidates('https://example.com/a.torrent\nmagnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'))
    .map(item => item.type).sort(),
  ['magnet', 'offlineUrl'],
)
assert.equal(api.extractCandidates('a https://115.com/s/abc123?pwd=x magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567').length, 2)
assert.equal(api.extractCandidates('115CID=88 and 115cid://99').length, 2)
assert.equal(api.rowIsDir({ fc: '0' }), true)
assert.equal(api.rowIsDir({ type: '0' }), true)
assert.equal(api.rowIsDir({ fc: '1', type: '1' }), false)
assert.equal(api.rowName({ file_name: '  剧集/季\\名称  ' }), '  剧集/季\\名称  ')
assert.equal(api.rowName({ n: 'n/name', name: 'name', fn: 'fn', file_name: 'file_name' }), 'n/name')
const unlocked = plain(api.extractDianyingCandidates({
  data: {
    share_code: 'Share987',
    receive_code: 'k9x2',
    urls: [
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      'https://example.com/not-supported',
    ],
  },
}))
assert.equal(unlocked.length, 2)
assert.deepEqual(unlocked.map(item => item.type).sort(), ['magnet', 'share115'])
console.log('115 transfer/offline userscript smoke test: PASS')
