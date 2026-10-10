# Live2D 表演接入方案

日期：2026-10-10。用户希望开始完善 Live2D 表演。本轮为能力核验与方案记录，尚未实现控制台到舞台的表演桥接。

## 已核验的固定版本能力

本机 AIRI HEAD 与 airi.lock.json 一致：34576c19f618a04e616657089f0688a8637873f2。以下结论来自该版本本机源码，不代表当前模型已实际支持每个动作。

- packages/i18n/src/locales/en/base.yaml 的 emotion 提示词规定在回答流中插入 ACT / DELAY / CALL 标记。ACT 可携带 emotion 与 motion，并在回复途中改变情绪。
- packages/stage-ui/src/components/scenes/Stage.vue:326 监听流式 act，Live2D motion 更新 currentMotion，emotion 映射为动作组；:892 在 speechMuted 时仍处理非音频信号，文字阶段也有复用入口。当前 act 同时含 motion 与 emotion 时，Live2D 分支先处理 motion 并 return，不能假定二者自动叠加。
- packages/stage-ui/src/constants/emotions.ts 将情绪映射到 Happy、Think、Surprise、Idle 等名称，名称不保证存在于任意模型。
- packages/stage-ui-live2d/src/components/scenes/live2d/Model.vue:562 从 model3.json 读取 exp3 表情；:590 用模型动作组播放预制动画。
- packages/stage-ui-live2d/src/stores/motion-control.ts 支持归一化眼睛、头、身体、嘴形、位置与呼吸控制，含惯性/跟随和控制权管理，可构建克制的倾听与点头姿态。
- packages/stage-ui-live2d/src/tools/expression-tools.ts 定义 expression_set/get/toggle/reset_all 等工具，带强度和持续时间；本次全文查找未发现 expressionTools 的接入调用方，不能把工具定义等同已接通模型工具调用。自定义表情系统默认关闭，需检查实际模型与设置。
- packages/model-driver-lipsync/src/live2d/index.ts 与 Stage.vue 的音频播放管线实现音频驱动嘴形；文字阶段未接 TTS，不能宣称已实现语音口型同步。

## 我们现有链路的缺口

控制台目前显示 5173 的 iframe，字幕在外层页面独立更新。DeepSeek 生成在 cohost 后端，尚未将动作/表情信号交给 AIRI。AIRI 的内部 BroadcastChannel 不直接跨 8787 与 5173 两个 origin。需要明确的跨页面连接、来源校验、模型能力回报与执行回执，不能仅向字幕加入标记就声称能控制形象。

## 建议的第一版范围

1. 盘点当前模型：导出可用动作组、表情文件与可控制参数；建立语义动作到真实资源的映射，缺失动作回退到轻微姿态。
2. 表演状态：待机、倾听、思考、说话、轻笑、惊讶，以及取消后回到倾听。眨眼/呼吸/平滑过渡由本机动画负责。
3. 模型负责简短意图：在同一次自主行动调用中附带情绪、动作、强度、持续时间；允许 wait 同时有非语言反应。快速回复复用流式表演标记的思路，解析后分别送字幕和动作，不额外串行调用表演模型。新增标记仍有少量输出开销，实测首字耗时。
4. 执行与时序：使用现有话轮编号，限制动作集合和强度，防止每句话重置整套动画；新话轮/打断取消旧动作，表情在限定时间后恢复。给舞台明确优先级，避免预制动画、眼神、眨眼和口型抢写同一参数。
5. 手动表演台：先让操作者点选预览动作并看到实际成功/缺失/取消，再联动真实 DeepSeek 回复。原控制台状态/多页面问题已登记，表演事件必须独立做话轮有效性和去重检查。
6. 验收：文字与姿态同时呈现；等待时可有克制非语言反应；旧动作不能在打断后继续；不支持的动作有明确回退；AIRI 重载或断开不阻塞文字回复。随后接 TTS 并用实际播放时间驱动口型/分句动作。

如需改 AIRI 上游源码，先读取对应嵌套指导，按固定版本保存可复现补丁，不能把唯一实现留在忽略的 vendor/airi。以上尚未编码或视觉验收。
