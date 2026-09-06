package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	goruntime "runtime"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const protocol = "dian115:wasm@1"
const frameSize = 16 << 20

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type rpcMessage struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type peer struct{}

//go:wasmimport dian115 host_call
func hostCall(ptr, length uint32) uint32

//go:wasmimport dian115 host_read
func hostRead(ptr, capacity uint32) uint32

func (p *peer) call(ctx context.Context, method string, params any, target any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	request, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		return err
	}
	size := hostCall(uint32(uintptr(unsafe.Pointer(&request[0]))), uint32(len(request)))
	goruntime.KeepAlive(request)
	if size == 0 || size > frameSize {
		return errors.New("invalid host response size")
	}
	response := make([]byte, size)
	if hostRead(uint32(uintptr(unsafe.Pointer(&response[0]))), size) != size {
		return errors.New("host response read failed")
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil {
		return err
	}
	if envelope.Error != "" {
		return errors.New(envelope.Error)
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, target)
}

var inputBuffer, outputBuffer []byte
var guest = newRuntime(&peer{})

//go:wasmexport dian115_alloc
func allocate(size uint32) uint32 {
	if size == 0 || size > frameSize {
		panic("invalid input size")
	}
	inputBuffer = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(&inputBuffer[0])))
}

//go:wasmexport dian115_handle
func handle(ptr, length uint32) uint64 {
	var message rpcMessage
	if length == 0 || length > frameSize {
		panic("invalid invocation size")
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), int(length))
	var result any
	var rpcErr *rpcError
	if json.Unmarshal(raw, &message) != nil {
		rpcErr = &rpcError{-32602, "invalid invocation"}
	} else {
		result, rpcErr, _ = guest.handle(message)
	}
	response := map[string]any{}
	if rpcErr != nil {
		response["error"] = rpcErr
	} else {
		response["result"] = result
	}
	var err error
	outputBuffer, err = json.Marshal(response)
	if err != nil {
		panic(err)
	}
	return uint64(uintptr(unsafe.Pointer(&outputBuffer[0])))<<32 | uint64(len(outputBuffer))
}

type runtimeState struct {
	Revision    int    `json:"revision"`
	ActionCount int    `json:"actionCount"`
	EventCount  int    `json:"eventCount"`
	WatchActive bool   `json:"watchActive"`
	LastStatus  string `json:"lastStatus"`
	LastMessage string `json:"lastMessage"`
}

type runtime struct {
	peer  *peer
	mu    sync.Mutex
	state runtimeState
}

type invokeParams struct {
	Envelope struct {
		Op           string          `json:"op"`
		InvocationID string          `json:"invocation_id"`
		Payload      json.RawMessage `json:"payload"`
	} `json:"envelope"`
	Background bool `json:"background"`
}

type hostCallRequest struct {
	Method        string            `json:"method"`
	Path          string            `json:"path"`
	Headers       map[string]string `json:"headers,omitempty"`
	BodyBase64    string            `json:"body_base64,omitempty"`
	CredentialRef string            `json:"credential_ref,omitempty"`
}

type hostCallResponse struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"body_base64"`
}

func newRuntime(channel *peer) *runtime {
	return &runtime{peer: channel, state: runtimeState{Revision: 1, LastStatus: "ready", LastMessage: "运行时已启动"}}
}

func (r *runtime) handle(message rpcMessage) (any, *rpcError, bool) {
	switch message.Method {
	case "runtime.initialize":
		var input struct {
			Protocol string `json:"protocol"`
		}
		if json.Unmarshal(message.Params, &input) != nil || input.Protocol != protocol {
			return nil, &rpcError{Code: -32602, Message: "unsupported process protocol"}, false
		}
		if err := r.registerTelegram(); err != nil {
			r.log("warning", "Telegram registration was not applied", map[string]any{"reason": err.Error()})
		}
		return map[string]any{"ready": true, "protocol": protocol}, nil, false
	case "runtime.invoke":
		var input invokeParams
		if json.Unmarshal(message.Params, &input) != nil || input.Envelope.Op == "" || input.Envelope.InvocationID == "" {
			return nil, &rpcError{Code: -32602, Message: "invalid runtime.invoke params"}, false
		}
		result, err := r.invoke(input)
		if err != nil {
			return nil, &rpcError{Code: -32602, Message: err.Error()}, false
		}
		return result, nil, false
	case "runtime.shutdown":
		return map[string]any{"stopping": true}, nil, true
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}, false
	}
}

func (r *runtime) invoke(input invokeParams) (any, error) {
	switch input.Envelope.Op {
	case "state":
		return r.stateResult(input.Envelope.Payload)
	case "action":
		return r.action(input.Envelope.InvocationID, input.Envelope.Payload)
	case "job":
		return r.job(input.Envelope.Payload)
	case "event":
		return r.event(input.Envelope.Payload)
	default:
		return nil, fmt.Errorf("unsupported invocation op %q", input.Envelope.Op)
	}
}

func (r *runtime) stateResult(raw json.RawMessage) (any, error) {
	var payload struct {
		View        string `json:"view"`
		IfNoneMatch string `json:"if_none_match"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil, errors.New("invalid state payload")
	}
	r.mu.Lock()
	snapshot := r.state
	r.mu.Unlock()
	version := fmt.Sprintf("state-v%d", snapshot.Revision)
	etag := `"` + version + `"`
	if payload.IfNoneMatch == etag {
		return map[string]any{"not_modified": true, "etag": etag}, nil
	}
	return map[string]any{"state_version": version, "etag": etag, "state": snapshot}, nil
}

func (r *runtime) action(invocationID string, raw json.RawMessage) (any, error) {
	var payload struct {
		ID    string          `json:"id"`
		Input json.RawMessage `json:"input"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.ID == "" {
		return nil, errors.New("invalid action payload")
	}
	switch payload.ID {
	case "refresh":
		r.updateState("succeeded", "运行时状态已刷新", false)
		return map[string]any{"status": "succeeded", "message": "运行时状态已刷新"}, nil
	case "send-test":
		body, _ := json.Marshal(map[string]any{
			"level": "success", "title": "插件测试通知", "body": "完整插件示例已成功调用宿主通知接口。",
			"dedupe_key": invocationID,
		})
		response, err := r.hostCall(hostCallRequest{
			Method: "POST", Path: "/api/notifications/plugin",
			Headers:    map[string]string{"content-type": "application/json", "idempotency-key": "example-notify-" + invocationID},
			BodyBase64: base64.RawStdEncoding.EncodeToString(body),
		})
		if err != nil || response.Status >= 400 {
			message := "宿主通知调用失败"
			if err != nil {
				message = err.Error()
			}
			r.updateState("failed", message, false)
			return map[string]any{"status": "failed", "message": message, "hostStatus": response.Status}, nil
		}
		r.updateState("succeeded", "测试通知已发送", false)
		return map[string]any{"status": "succeeded", "message": "测试通知已发送", "hostStatus": response.Status}, nil
	case "storage-demo":
		return r.storageDemo(invocationID)
	case "external-link":
		return map[string]any{"status": "succeeded", "message": "外部页面地址已生成", "url": "https://example.com/oauth/start"}, nil
	case "fetch-local":
		var actionInput struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(payload.Input, &actionInput) != nil || strings.TrimSpace(actionInput.URL) == "" {
			return map[string]any{"status": "failed", "message": "URL 不能为空"}, nil
		}
		response, err := r.hostCall(hostCallRequest{Method: "GET", Path: strings.TrimSpace(actionInput.URL), Headers: map[string]string{"accept": "application/json, text/plain;q=0.9"}})
		if err != nil || response.Status >= 400 {
			message := "宿主网络 Broker 调用失败"
			if err != nil {
				message = err.Error()
			}
			r.updateState("failed", message, false)
			return map[string]any{"status": "failed", "message": message, "hostStatus": response.Status}, nil
		}
		r.updateState("succeeded", fmt.Sprintf("宿主 Broker 返回 HTTP %d", response.Status), false)
		return map[string]any{"status": "succeeded", "message": "宿主 Broker 请求完成", "hostStatus": response.Status}, nil
	case "create-watch":
		var actionInput struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(payload.Input, &actionInput) != nil || strings.TrimSpace(actionInput.Path) == "" {
			return map[string]any{"status": "failed", "message": "目录路径不能为空"}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"source":      map[string]any{"kind": "host_path", "path": strings.TrimSpace(actionInput.Path)},
			"event_topic": "files.changed", "recursive": true, "interval_seconds": 30,
		})
		response, err := r.hostCall(hostCallRequest{
			Method: "POST", Path: "/api/plugin-runtime/watches",
			Headers:    map[string]string{"content-type": "application/json", "idempotency-key": "example-watch-" + invocationID},
			BodyBase64: base64.RawStdEncoding.EncodeToString(body),
		})
		if err != nil || response.Status >= 400 {
			message := "目录监控创建失败"
			if err != nil {
				message = err.Error()
			}
			r.updateState("failed", message, false)
			return map[string]any{"status": "failed", "message": message, "hostStatus": response.Status}, nil
		}
		r.updateState("succeeded", "目录监控已创建", true)
		return map[string]any{"status": "succeeded", "message": "目录监控已创建", "hostStatus": response.Status}, nil
	default:
		return map[string]any{"status": "failed", "code": "unknown_action", "message": "未知动作"}, nil
	}
}

func (r *runtime) storageDemo(invocationID string) (any, error) {
	const path = "/api/plugin-runtime/storage/example"
	response, err := r.hostCall(hostCallRequest{Method: "GET", Path: path, Headers: map[string]string{"accept": "application/json"}})
	if err != nil {
		return map[string]any{"status": "failed", "message": err.Error()}, nil
	}
	if response.Status != 200 && response.Status != 404 {
		return map[string]any{"status": "failed", "message": fmt.Sprintf("Host Storage 读取失败（HTTP %d）", response.Status)}, nil
	}
	value, _ := json.Marshal(map[string]any{"saved_by": "complete-plugin", "updated_at": time.Now().UTC().Format(time.RFC3339Nano)})
	body, _ := json.Marshal(map[string]json.RawMessage{"value": value})
	headers := map[string]string{
		"content-type":    "application/json",
		"accept":          "application/json",
		"idempotency-key": "complete-storage-" + invocationID,
	}
	if etag := firstHeader(response.Headers, "ETag"); etag != "" {
		headers["if-match"] = etag
	}
	writeResponse, writeErr := r.hostCall(hostCallRequest{Method: "PUT", Path: path, Headers: headers, BodyBase64: base64.RawStdEncoding.EncodeToString(body)})
	if writeErr != nil || writeResponse.Status >= 400 {
		if writeErr != nil {
			return map[string]any{"status": "failed", "message": writeErr.Error()}, nil
		}
		return map[string]any{"status": "failed", "message": fmt.Sprintf("Host Storage 写入失败（HTTP %d）", writeResponse.Status)}, nil
	}
	r.updateState("succeeded", "Host Storage 已使用 ETag/CAS 保存示例数据", false)
	return map[string]any{"status": "succeeded", "message": "Host Storage 已使用 ETag/CAS 保存示例数据", "hostStatus": writeResponse.Status}, nil
}

func firstHeader(headers map[string][]string, name string) string {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}

func (r *runtime) job(raw json.RawMessage) (any, error) {
	var payload struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.ID != "refresh" {
		return map[string]any{"status": "skipped", "message": "未声明的任务"}, nil
	}
	r.updateState("succeeded", "定时刷新已接受", false)
	return map[string]any{"status": "accepted", "message": "定时刷新已接受"}, nil
}

func (r *runtime) event(raw json.RawMessage) (any, error) {
	var payload struct {
		Topic string          `json:"topic"`
		Data  json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Topic == "" {
		return nil, errors.New("invalid event payload")
	}
	if payload.Topic == "telegram.message" {
		var data struct {
			Match struct {
				Type  string `json:"type"`
				Value string `json:"value"`
			} `json:"match"`
		}
		_ = json.Unmarshal(payload.Data, &data)
		r.updateState("succeeded", "已处理 Telegram "+data.Match.Type, false)
		return map[string]any{
			"handled": true,
			"reply": map[string]any{
				"format": "plain", "text": "完整插件示例已收到：" + data.Match.Value,
				"buttons": [][]map[string]string{{{"text": "查看文档", "url": "https://example.com/plugins/complete-plugin"}}},
			},
		}, nil
	}
	r.mu.Lock()
	r.state.EventCount++
	r.state.Revision++
	r.state.LastStatus = "succeeded"
	r.state.LastMessage = "已接收事件：" + payload.Topic
	r.mu.Unlock()
	return map[string]any{"accepted": true}, nil
}

func (r *runtime) updateState(status, message string, watchActive bool) {
	r.mu.Lock()
	r.state.Revision++
	r.state.ActionCount++
	r.state.LastStatus = status
	r.state.LastMessage = message
	if watchActive {
		r.state.WatchActive = true
	}
	r.mu.Unlock()
}

func (r *runtime) hostCall(request hostCallRequest) (hostCallResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var response hostCallResponse
	err := r.peer.call(ctx, "host.call", request, &response)
	return response, err
}

func (r *runtime) registerTelegram() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var response struct {
		Commands []any `json:"commands"`
		Keywords []any `json:"keywords"`
	}
	return r.peer.call(ctx, "host.telegram.register", map[string]any{
		"commands": []map[string]string{{"command": "plugin_example", "description": "打开完整插件示例"}},
		"keywords": []map[string]string{{"keyword": "完整插件示例", "match": "exact"}},
	}, &response)
}

func (r *runtime) log(level, message string, fields map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var ignored map[string]any
	_ = r.peer.call(ctx, "host.log", map[string]any{"level": level, "message": message, "fields": fields}, &ignored)
}

func main() {}
