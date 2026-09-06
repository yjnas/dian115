<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NGrid,
  NGridItem,
  NIcon,
  NInput,
  NStatistic,
  NTag,
  useMessage,
} from 'naive-ui'
import { Bell, ExternalLink, FolderSearch, Globe2, HardDrive, RefreshCw, Save } from '@lucide/vue'
import pluginIconURL from '../frontend/icon.svg'

interface RuntimeCallback {
  invocation_id?: string
  replayed?: boolean
  result?: {
    status?: 'succeeded' | 'failed' | 'accepted' | 'skipped'
    message?: string
    [key: string]: unknown
  }
}

interface HostBridge {
  getState(view?: string): Promise<{ state?: Record<string, unknown>; state_version?: string; etag?: string }>
  invokeAction(action: string, input?: unknown): Promise<RuntimeCallback>
  refresh(): Promise<Record<string, unknown>>
}

interface PluginRuntimeSummary {
  health_status?: string
  process_state?: string
  pid?: number
  [key: string]: unknown
}

const props = defineProps<{
  api: HostBridge
  hostApi?: HostBridge
  installationId?: number
  pluginId?: string
  runtime?: PluginRuntimeSummary | null
  runtimeState?: Record<string, unknown>
  navKey?: string
  themeContract?: string
}>()

const message = useMessage()
const busyAction = ref('')
const watchPath = ref('')
const localURL = ref('http://127.0.0.1:8080/health')
const browserNote = ref(localStorage.getItem('complete-plugin.browser-note') || '')
const state = computed(() => props.runtimeState || {})

function saveBrowserNote() {
  localStorage.setItem('complete-plugin.browser-note', browserNote.value)
  message.success('已保存到浏览器 localStorage')
}

async function openExternal() {
  // Open synchronously from the click, then navigate after the runtime action resolves.
  const popup = window.open('about:blank', '_blank', 'popup,width=1080,height=760')
  if (!popup) {
    message.warning('浏览器阻止了弹窗，请允许当前页面打开新窗口')
    return
  }
  busyAction.value = 'external-link'
  try {
    const response = await props.api.invokeAction('external-link', {})
    const result = response.result || {}
    const url = String(result.url || '')
    if (result.status === 'failed' || !/^https?:\/\//i.test(url)) throw new Error(String(result.message || '外部地址无效'))
    popup.location.replace(url)
  } catch (error: any) {
    popup.close()
    message.error(String(error?.message || '打开外部页面失败'))
  } finally {
    busyAction.value = ''
  }
}

async function runAction(action: string, input: Record<string, unknown> = {}) {
  busyAction.value = action
  try {
    const response = await props.api.invokeAction(action, input)
    const result = response.result || {}
    if (result.status === 'failed') throw new Error(String(result.message || '插件动作失败'))
    await props.api.refresh()
    message.success(String(result.message || '操作完成'))
  } catch (error: any) {
    message.error(String(error?.message || '操作失败'))
  } finally {
    busyAction.value = ''
  }
}

async function createWatch() {
  const path = watchPath.value.trim()
  if (!path) {
    message.warning('请输入宿主文件管理器中的目录路径')
    return
  }
  await runAction('create-watch', { path })
}
</script>

<template>
  <main class="dian-plugin-page example-page">
    <header class="page-header">
      <div>
        <h2>完整插件示例</h2>
        <p>WASM 运行时、Host Call、目录监控、Telegram 与主题契约。</p>
      </div>
      <NTag type="success" size="small">{{ themeContract || 'dian115-theme-v1' }}</NTag>
    </header>

    <NAlert v-if="state.lastMessage" :type="state.lastStatus === 'failed' ? 'error' : 'info'" :bordered="false">
      {{ state.lastMessage }}
    </NAlert>

    <section class="metrics" aria-label="插件运行摘要">
      <NGrid cols="1 s:3" responsive="screen" :x-gap="12" :y-gap="12">
        <NGridItem><NStatistic label="状态版本" :value="String(state.revision || 1)" /></NGridItem>
        <NGridItem><NStatistic label="动作次数" :value="Number(state.actionCount || 0)" /></NGridItem>
        <NGridItem><NStatistic label="事件次数" :value="Number(state.eventCount || 0)" /></NGridItem>
      </NGrid>
    </section>

    <section class="actions" aria-label="插件操作">
      <NButton type="primary" :loading="busyAction === 'send-test'" @click="runAction('send-test')">
        <template #icon><NIcon :component="Bell" /></template>
        发送测试通知
      </NButton>
      <NButton :loading="busyAction === 'refresh'" @click="runAction('refresh')">
        <template #icon><NIcon :component="RefreshCw" /></template>
        刷新运行时状态
      </NButton>
      <NButton :loading="busyAction === 'external-link'" @click="openExternal">
        <template #icon><NIcon :component="ExternalLink" /></template>
        打开外部授权页
      </NButton>
    </section>

    <section class="tool-panel">
      <div class="section-heading">
        <img class="plugin-preview-image" :src="pluginIconURL" alt="完整插件示例图标">
        <div>
          <h3>图片与浏览器存储</h3>
          <p>图片来自签名包；同源插件页可以使用 localStorage、sessionStorage 和 IndexedDB。</p>
        </div>
      </div>
      <NForm label-placement="top" @submit.prevent="saveBrowserNote">
        <NFormItem label="浏览器备注">
          <NInput v-model:value="browserNote" placeholder="刷新页面后仍会保留" clearable />
        </NFormItem>
        <NButton attr-type="submit">
          <template #icon><NIcon :component="Save" /></template>
          保存到浏览器
        </NButton>
      </NForm>
    </section>

    <section class="tool-panel">
      <div class="section-heading">
        <NIcon :component="HardDrive" :size="20" />
        <div>
          <h3>Host Storage</h3>
          <p>host-api-only 模式下使用同一接口保存插件私有状态，ETag 和幂等键由宿主保护。</p>
        </div>
      </div>
      <NButton :loading="busyAction === 'storage-demo'" @click="runAction('storage-demo')">
        <template #icon><NIcon :component="HardDrive" /></template>
        读写示例数据
      </NButton>
    </section>

    <section class="tool-panel">
      <div class="section-heading">
        <NIcon :component="Globe2" :size="20" />
        <div>
          <h3>宿主网络 Broker</h3>
          <p>HTTP、HTTPS、localhost、局域网和其他容器地址都由宿主访问；宿主代理规则优先。</p>
        </div>
      </div>
      <NForm label-placement="top" @submit.prevent="runAction('fetch-local', { url: localURL })">
        <NFormItem label="本地或局域网 URL">
          <NInput v-model:value="localURL" placeholder="例如 http://127.0.0.1:8080/health" clearable />
        </NFormItem>
        <NButton attr-type="submit" type="primary" :loading="busyAction === 'fetch-local'">通过宿主请求</NButton>
      </NForm>
    </section>

    <section class="watch-panel">
      <div class="section-heading">
        <NIcon :component="FolderSearch" :size="20" />
        <div>
          <h3>创建目录监控</h3>
          <p>路径由宿主文件管理器解析，受系统目录和 /config 保护规则限制。</p>
        </div>
      </div>
      <NForm label-placement="top" @submit.prevent="createWatch">
        <NFormItem label="宿主目录路径">
          <NInput v-model:value="watchPath" placeholder="例如 /media/incoming" clearable />
        </NFormItem>
        <NButton attr-type="submit" :loading="busyAction === 'create-watch'">创建监控</NButton>
      </NForm>
    </section>
  </main>
</template>

<style scoped>
.example-page {
  display: grid;
  gap: var(--dian-space-4);
  padding: var(--dian-space-1);
}

.page-header,
.section-heading,
.actions {
  display: flex;
  align-items: center;
  gap: var(--dian-space-3);
}

.page-header {
  justify-content: space-between;
  border-bottom: 1px solid var(--dian-divider);
  padding-bottom: var(--dian-space-4);
}

.page-header > div,
.section-heading > div {
  min-width: 0;
}

h2,
h3,
p {
  margin: 0;
  letter-spacing: 0;
}

h2,
h3 {
  color: var(--dian-text-primary);
}

h2 { font-size: 22px; }
h3 { font-size: 16px; }

p {
  margin-top: var(--dian-space-1);
  color: var(--dian-text-secondary);
  overflow-wrap: anywhere;
}

.metrics,
.watch-panel,
.tool-panel {
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-lg);
  background: var(--dian-surface-raised);
  padding: var(--dian-space-4);
}

.actions {
  flex-wrap: wrap;
}

.section-heading {
  align-items: flex-start;
  margin-bottom: var(--dian-space-4);
  color: var(--dian-primary);
}

.plugin-preview-image {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  object-fit: contain;
  border: 1px solid var(--dian-border);
  border-radius: var(--dian-radius-sm);
  background: var(--dian-surface-soft);
}

@media (max-width: 600px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .actions > * {
    flex: 1 1 100%;
  }
}
</style>
