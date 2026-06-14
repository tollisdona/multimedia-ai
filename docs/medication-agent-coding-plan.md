# LangChain 药品说明书 Agent 编码计划

## 目标

在保留现有实时视频对话基本流程的前提下，新增一个自动触发的药品说明书识别子 Agent：

1. 用户通过语音或文字表达“帮我看药品说明书 / 这个药怎么吃 / 识别药盒药瓶文字”等意图。
2. 后端自动识别该意图，不要求用户手动切换角色或模式。
3. 系统在对话框里提示“已切换到药品说明书识别场景”。
4. Assistant 指导用户将药品说明书、药盒或药瓶标签对准镜头。
5. 后端通过类 Agent 工具流请求前端截图，执行 OCR，校验识别质量。
6. OCR 合格后，模型基于 OCR 文本和必要的图像上下文回答用户问题。
7. 完成一次回答后进入短期追问态；若后续问题不再与药品相关，自动回到普通视频对话。

这不是替换现有视频对话助手，而是在 `ConversationPipeline` 下挂一个 `MedicationInstructionAgent` specialist。

## 当前代码切入点

现有主流程：

```text
frontend/src/App.tsx
  -> GatewayClient.send("browser.asr.final", { text })
  -> backend/app/gateway.py::handle_final_transcript()
  -> backend/app/conversation_pipeline.py::ConversationPipeline.run_user_turn()
  -> backend/app/ai.py::stream_direct_model()
  -> frontend handleGatewayEvent() 渲染 llm.delta / tts.audio.chunk
```

药品 Agent 应插入在 `ConversationPipeline.run_user_turn()` 的最前面：

```text
run_user_turn(user_text)
  -> medication intent / follow-up router
  -> if medication: run MedicationInstructionAgent
  -> else: stream_direct_model()
```

## 依赖选择

使用 LangChain 的 `create_agent` 和 tools 机制实现 agentic 工具调用。官方文档说明 LangChain agents 可以接收 Python callable / LangChain tool / tool dict 作为 tools；安装文档和 PyPI 均显示当前 LangChain 需要 Python 3.10+。

编码影响：

- 如果本机后端仍是 Python 3.9，需要先升级 backend venv 到 Python 3.10+。
- `backend/requirements.txt` 新增：

```text
langchain
langchain-openai
```

如果暂时不能升级 Python，则先用同样的模块边界写一个轻量 async state machine，后续把内部 executor 替换成 LangChain。

## 后端新增模块

### 1. `backend/app/medication_intent.py`

职责：判断当前用户话语是否应该进入或继续药品说明书 Agent。

建议 API：

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class MedicationIntent:
    matched: bool
    confidence: float
    reason: str
    is_followup: bool = False

def detect_medication_intent(user_text: str, active_context: bool) -> MedicationIntent:
    ...
```

第一版先用规则，不调用大模型：

- 强命中关键词：`药品说明书`, `药盒`, `药瓶`, `用法用量`, `禁忌`, `副作用`, `这个药怎么吃`, `一天几次`, `吃几片`, `饭前`, `饭后`
- 动作关键词：`帮我看`, `识别`, `读一下`, `看看说明书`, `怎么吃`, `能不能吃`
- follow-up：如果 `active_context=True`，且用户问 `那`, `这个`, `注意事项`, `老人`, `禁忌`, `饭前饭后`, `多久一次`，继续药品上下文。
- 明确退出：`不用了`, `取消`, `先不看药了`, `换个问题`, `回到普通模式`

触发门槛必须保守：

- 不能因为单独出现 `看`, `识别`, `文字`, `说明` 就进入药品 Agent。
- 至少满足 `药品对象关键词 + 阅读/用药动作关键词`，或命中完整短语如 `这个药怎么吃`、`帮我看药品说明书`。
- 如果用户只说 `帮我看看这个`、`识别文字`、`看一下说明`，继续走普通视觉问答。
- 如果处于 Realtime 会话刚启动、重连后、或后端未确认云端已 append 过音频，不主动触发药品截图请求，只先让 Assistant 口头指导用户对准镜头。

### 2. `backend/app/medication_models.py`

职责：定义药品 Agent 的状态和 OCR 结果结构。

建议 dataclass：

```python
@dataclass
class MedicationOcrResult:
    text: str
    confidence: float
    blocks: list[dict[str, str]]
    image_hash: str
    captured_at: int

@dataclass
class MedicationAgentState:
    status: str  # idle | awaiting_frame | ocr_running | ready_for_followup
    started_at: int
    last_active_at: int
    retries: int = 0
    last_ocr: MedicationOcrResult | None = None
    source_question: str = ""
```

并在 `backend/app/models.py::SessionState` 增加：

```python
medication_agent: MedicationAgentState | None = None
```

### 3. `backend/app/medication_tools.py`

职责：LangChain tools 的后端实现。

建议 tools：

```text
request_camera_frame
run_ocr
assess_ocr_quality
request_retake
answer_from_ocr
```

注意：`request_camera_frame` 不是后端真的截图，而是通过 Gateway 发 WebSocket 事件给前端，再等待前端回传 frame。

工具实现建议：

```python
async def request_camera_frame(reason: str) -> FrameSnapshot | None:
    # emit "vision.capture.request"
    # await a future resolved by gateway.handle_vision_frame()

async def run_ocr(frame: FrameSnapshot) -> MedicationOcrResult:
    # MVP 可以先调用多模态模型做 OCR-like text extraction
    # 后续替换为 PaddleOCR / 云 OCR

def assess_ocr_quality(result: MedicationOcrResult) -> dict[str, object]:
    # text length, confidence, key section presence
```

质量门槛：

- OCR 文本长度太短：重拍
- 没有药名且没有用法用量：重拍
- 置信度低于阈值：重拍
- 连续重拍超过 2 次：退出 Agent 并提示用户换光线或手动输入

### 4. `backend/app/medication_agent.py`

职责：创建并运行 LangChain 药品子 Agent。

建议 API：

```python
class MedicationInstructionAgent:
    def __init__(self, session: SessionState, emit: Callable[..., Awaitable[None]]) -> None:
        ...

    async def run(self, user_text: str) -> AsyncIterator[PipelineEvent]:
        ...
```

系统 prompt 关键约束：

```text
你是药品说明书阅读助手，不是医生。
只能基于 OCR 文本和图像中明确可见的信息回答。
不得补全缺失的药名、剂量、频次、禁忌。
如果 OCR 不清晰或关键信息缺失，必须要求用户重新对准镜头。
涉及老人、儿童、孕妇、慢病、过敏、联合用药时，提醒咨询医生或药师。
回答要口语化、简洁，适合朗读。
```

回答格式：

```text
我识别到的关键信息：
用法用量：
注意事项：
我不确定的地方：
建议：
```

LangChain agent 应只注册药品相关 tools，不注册普通视觉问答工具，避免工具边界失控。

### 5. `backend/app/medication_ocr.py`

职责：OCR 适配层。

第一版实现两条路径：

1. 有模型配置时，调用 OpenAI-compatible multimodal API 提取画面文字。
2. 无模型配置时，返回 mock OCR，便于前端和协议联调。

后续可扩展：

- PaddleOCR 本地识别
- 云 OCR
- 对小字说明书做图像裁剪、增强、分块识别

## 后端现有文件改动

### `backend/app/conversation_pipeline.py`

新增路由逻辑：

```python
async def run_user_turn(self, user_text: str) -> AsyncIterator[PipelineEvent]:
    intent = detect_medication_intent(user_text, active_context=self.session.medication_agent is not None)

    if intent.matched:
        agent = MedicationInstructionAgent(self.session, self.emit_to_gateway)
        async for event in agent.run(user_text):
            yield event
        return

    if should_exit_medication_context(user_text, self.session.medication_agent):
        self.session.medication_agent = None

    async for event in self.run_general_turn(user_text):
        yield event
```

为避免 `ConversationPipeline` 直接知道 WebSocket 细节，建议在初始化时传入一个可选 `emit` callback：

```python
ConversationPipeline(self.session, emit=self.send)
```

### `backend/app/gateway.py`

新增能力：

1. 创建 pipeline 时传入 `self.send`。
2. 支持 agent 请求前端截图的 pending future。
3. `handle_vision_frame()` 在正常缓存关键帧后，如果当前有 `pending_capture_request`，解析为 agent 所需 frame 并唤醒等待者。
4. 对 Realtime 图片追加增加后端权威保护：只有当前 DashScope Realtime session 已成功发送至少一个 `input_audio_buffer.append` 后，才允许调用 `realtime.append_image(...)`。
5. 药品 Agent 请求的截图帧只用于 OCR / agent 工具链，默认不转发到 Qwen Realtime `input_image_buffer.append`。

新增接收事件：

```text
vision.capture.failed
```

现有 `vision.frame` 可复用，不必强行新增 `vision.frame.response`，但建议 frame payload 增加：

```json
{
  "reason": "medication-agent",
  "requestId": "...",
  "realtimeEligible": false
}
```

Realtime 图片顺序保护建议：

```python
if self.realtime and realtime_eligible:
    if self.realtime.audio_append_seen:
        await self.realtime.append_image(data_url)
    else:
        # 不向云端 append image，避免 Error append image before append audio.
        # 普通视觉帧只缓存；药品帧交给 pending_capture_request / OCR。
        await self.send("vision.frame.cached", reason=reason, realtimeDeferred=True, ...)
```

不要依赖前端的 `audioReadyForVisionRef` 作为最终判断。它只说明浏览器发出过音频 chunk，不证明新的 DashScope Realtime session 已成功收到 `input_audio_buffer.append`。后端必须维护每个 Realtime provider 实例自己的 audio-ready 状态。

### `backend/app/realtime.py`

新增状态：

```python
class QwenRealtimeProvider:
    audio_append_seen: bool = False
```

状态规则：

- `connect()` / `close()` / reconnect 后重置为 `False`。
- `append_audio()` 在 `send_raw({"type": "input_audio_buffer.append", ...})` 成功返回后置为 `True`。
- `append_image()` 如果 `audio_append_seen=False`，不直接向云端发送，可以返回 `False` 或抛出受控异常，由 Gateway 缓存/跳过/延迟处理。
- `cancel()` 只清 input audio buffer，不应把 `audio_append_seen` 当作永久可用；如果实际 provider 重连，要随新连接重置。

### `backend/app/ai.py`

复用：

- `direct_model_config`
- `strip_data_url`
- usage 统计模式

新增或拆出：

- `stream_chat_completions(messages, session, modality)` 通用流式调用，避免 medication agent 重复写 HTTP streaming。
- `run_vision_text_extraction(frame)` 给 OCR MVP 使用。

### `backend/app/models.py`

增加 agent session state：

```python
medication_agent: MedicationAgentState | None = None
```

如果不想引入循环 import，可以把 `MedicationAgentState` 放进 `models.py`，或在 `SessionState` 中先用 `dict[str, Any] | None`，但优先使用 dataclass 类型。

## WebSocket 协议扩展

### Backend -> Frontend

```text
scene.switched
```

payload：

```json
{
  "scene": "medication_instruction",
  "label": "药品说明书识别",
  "message": "已切换到药品说明书识别。我会先识别画面文字，再基于识别结果回答。"
}
```

```text
vision.capture.request
```

payload：

```json
{
  "requestId": "uuid",
  "reason": "medication-agent",
  "quality": "high",
  "realtimeEligible": false,
  "instruction": "请将药品说明书、药盒或药瓶标签对准镜头，尽量让药名和用法用量清晰可见。"
}
```

```text
ocr.started
ocr.result
ocr.retake.requested
agent.exited
```

`ocr.result` payload：

```json
{
  "textPreview": "识别文本前 160 字",
  "confidence": 0.82,
  "accepted": true
}
```

### Frontend -> Backend

复用：

```text
vision.frame
```

增加字段：

```json
{
  "requestId": "uuid",
  "reason": "medication-agent",
  "image": "data:image/jpeg;base64,...",
  "realtimeEligible": false
}
```

新增失败事件：

```text
vision.capture.failed
```

payload：

```json
{
  "requestId": "uuid",
  "reason": "camera_unavailable | frame_blurry | timeout"
}
```

## 前端改动

### `frontend/src/types.ts`

扩展 `GatewayEvent`：

```ts
| { type: "scene.switched"; scene: "medication_instruction"; label: string; message: string }
| { type: "vision.capture.request"; requestId: string; reason: string; quality: "high" | "normal"; instruction: string }
| { type: "ocr.started"; requestId: string }
| { type: "ocr.result"; textPreview: string; confidence: number; accepted: boolean }
| { type: "ocr.retake.requested"; requestId: string; reason: string; instruction: string }
| { type: "agent.exited"; agent: "medication_instruction"; reason: string }
```

### `frontend/src/App.tsx`

#### 1. `handleGatewayEvent()`

新增处理：

```ts
if (event.type === "scene.switched") {
  appendMessage({ id: uid(), role: "system", text: event.message });
}

if (event.type === "vision.capture.request") {
  appendMessage({ id: uid(), role: "assistant", text: event.instruction });
  await captureFrameForRequest(event.requestId, event.reason, event.quality);
}

if (event.type === "ocr.started") {
  appendMessage({ id: uid(), role: "system", text: "正在识别说明书文字..." });
}

if (event.type === "ocr.retake.requested") {
  appendMessage({ id: uid(), role: "assistant", text: event.instruction });
}
```

#### 2. 新增高质量截图函数

当前 `captureFrame()` 会为了实时传输压缩到较小尺寸。药品说明书 OCR 需要高质量截图，建议新增：

```ts
const captureFrameForRequest = useCallback(
  async (requestId: string, reason: string, quality: "high" | "normal") => {
    // high: width 1280 or 1440, jpeg 0.88-0.92
    // normal: reuse current compression
    // send vision.frame with requestId
  },
  [...]
);
```

如果摄像头未开启：

- 前端尝试启动摄像头，或
- 回传 `vision.capture.failed`，后端让 Assistant 提示用户启动摄像头。

抓图节流和顺序要求：

- 药品 Agent 截图必须由后端 `vision.capture.request` 驱动，不能由前端关键词粗放触发。
- `sendFinalTranscript()` 中的普通 `containsVisualIntent(clean)` 不能覆盖药品 Agent 的截图策略；药品意图应先发文本到后端，让后端决定是否请求截图。
- 如果仍保留普通视觉关键词自动抓图，建议改为 `client.send("browser.asr.final", { text })` 之后再延迟请求普通语义帧，并由后端判断是否允许 append 到 Realtime。
- 前端的 `audioReadyForVisionRef` 只能作为体验优化，不作为云端 Realtime 图片发送许可。
- 对 `reason === "medication-agent"` 的截图，发送 payload 时显式带 `realtimeEligible: false`，避免 Gateway 转发给 `input_image_buffer.append`。

#### 3. 对话框场景提示

不要新增复杂模式切换 UI。只在消息流中插入轻提示：

```text
已切换到「药品说明书识别」。请将药品说明书对准镜头。
```

UI 要求：

- 使用 system message 或 compact banner。
- 不能使用 emoji 作为结构图标。
- 触控按钮保持至少 44px。
- OCR 失败/重拍提示要靠近消息流，不要只放 toast。

## Agent 退出策略

默认：一次 OCR 成功并回答后，退出 active agent，但保留 OCR 上下文 3 分钟或 3 个追问。

状态：

```text
idle
medication.awaiting_frame
medication.ocr_running
medication.ready_for_followup
```

退出条件：

1. 正常回答完成后：`active_agent = None`，`medication_followup_until = now + 3min`。
2. 连续 OCR 失败超过 2 次：退出并提示换光线、靠近镜头或手动输入。
3. 用户明确取消：立即退出。
4. 请求截图 60 秒无响应：退出。
5. follow-up 窗口中用户话题明显非药品：退出并走普通视频问答。

## 分阶段实施

### Phase 1: 协议和状态打通

- 增加 `MedicationAgentState`。
- 增加保守 intent router，禁止用 `看/识别/文字` 这类粗关键词直接触发药品 Agent。
- 增加 `scene.switched` 和 `vision.capture.request` 事件。
- 前端收到请求后能高质量截图并带 `requestId`、`realtimeEligible:false` 回传。
- 后端 Realtime provider 维护 `audio_append_seen`，未就绪时不向 DashScope append image。
- 药品 Agent 截图默认只进入 OCR 工具链，不进入 Qwen Realtime image buffer。
- 不接 LangChain，先用 mock agent 验证闭环。

验收：

```text
用户说“帮我看看这个药怎么吃”
-> 前端出现场景切换提示
-> Assistant 提示对准镜头
-> 前端自动截图
-> 后端收到 requestId 对应的 vision.frame
-> 后端不调用 realtime.append_image，因为 medication-agent frame realtimeEligible=false
-> Realtime session 未收到音频时不会出现 append image before append audio
```

### Phase 2: OCR 工具和质量判断

- 增加 `medication_ocr.py`。
- 先实现 mock OCR 和可选 multimodal OCR。
- 增加 `ocr.started`、`ocr.result`、`ocr.retake.requested`。

验收：

```text
截图清晰 -> ocr.result accepted=true
截图不清晰/mock low quality -> ocr.retake.requested
超过 retry 上限 -> agent.exited
```

### Phase 3: LangChain Agent 接入

- 升级 Python 到 3.10+。
- 增加 `langchain`、`langchain-openai`。
- 用 `create_agent` 注册受限 tools。
- Agent 只处理药品说明书场景，不接管普通对话。

验收：

```text
药品问题进入 LangChain agent
普通视觉问题仍走 stream_direct_model
Agent 不能在无 OCR 文本时输出剂量/频次
```

### Phase 4: 安全回答和追问态

- 增加药品安全 prompt。
- 首次回答后保留 OCR 上下文 3 分钟或 3 个药品追问。
- 非药品追问自动回普通流程。

验收：

```text
用户追问“那饭前还是饭后？” -> 使用上一次 OCR
用户改问“桌上有什么？” -> 退出药品上下文，普通视觉回答
```

### Phase 5: 测试和文档

新增测试：

- intent router 单元测试
- 粗关键词不触发测试：`识别文字`、`帮我看看这个`、`看一下说明` 不进入药品 Agent
- OCR 质量判断单元测试
- agent 退出策略单元测试
- Gateway `vision.capture.request` / `vision.frame` requestId 对应测试
- Realtime 顺序测试：`audio_append_seen=False` 时 `vision.frame` 不调用 `realtime.append_image`
- Realtime 重连测试：新 provider/session 的 `audio_append_seen` 必须重置为 `False`
- 前端事件 union 类型编译测试

更新：

- `README.md` Streaming Events
- `docs/design.md` 增加药品 Agent 小节

## 风险控制

1. 不让 LangChain agent 全局接管对话。
2. 不在没有 OCR 结果时回答药品剂量。
3. 不保存原始药品图片到数据库。
4. OCR 低质量时优先重拍，不让模型猜。
5. 所有药品回答必须包含不确定性边界。
6. 说明书识别是辅助阅读，不替代医生或药师建议。
7. 药品 Agent 触发词必须保守，避免普通视觉问答被误路由。
8. 任何图片进入 Qwen Realtime 前，后端必须确认当前 Realtime session 已成功 append 过音频。
9. 药品 OCR 截图默认不进入 Qwen Realtime image buffer，只进入 agent/OCR 分支。

## 推荐首个 PR 范围

首个 PR 不直接接完整 LangChain，先做最小闭环：

```text
intent_router
scene.switched
vision.capture.request
requestId frame matching
mock OCR
安全回答 prompt
```

确认前后端事件闭环稳定后，再单独 PR 接入 LangChain。这样可以把协议风险和 agent 框架风险拆开，调试会轻很多。
