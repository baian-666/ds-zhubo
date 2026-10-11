# 鲸鱼娘 Live2D 表演

更新：2026-10-11。本轮已接入本机网页舞台和 Electron 桌面舞台。

## 直接试用

打开 http://127.0.0.1:8787/ 并刷新。网页仍使用默认预设时，会首次导入本机准备的鲸鱼娘；已有自定义模型不会被自动替换。旧模型、显示设置备份在该浏览器的 cohost/previous-model 中，之后手动选择其他模型也不会被反复换回。

点舞台下方按钮：

| 按钮 | 鲸鱼娘实际表演 |
| --- | --- |
| 轻笑 | 开心兴奋表情，眯眼和轻微歪头 |
| 思考 | 头旁出现问号，视线偏移 |
| 惊讶 | 头旁出现感叹号，配合头部动作 |
| 嘴硬 | 生气表情和歪头 |
| 点头 | 增强的上下点头 |
| 恢复 | 清除本轮表情、释放姿态控制 |

表演约三秒后结束；“让小鲸鱼停一下”也能清除当前动作。网页状态行会显示已执行的原生表情名称。桌面角色同步接收这些按钮的指令；本机网页与桌面可以同时显示，但语音仍只有一个舞台收音、出声。

导演及流式回复现在同时支持基础姿态和 AI 自行编排的连续动作。同一次回复携带表演，不额外调用动作模型。基础按钮仍用于人工检查；自主表演的新增验证见下方。

## AI 自主编排（2026-10-11）

笑眼叠加修正：鲸鱼娘开心兴奋的 ParamCheek76 是替换眼睛的开关，0.25/0.7 会使笑眼与正常眼睛同时透出。该图层现在完整切换，眉毛、歪头等仍按强度变化；不改变原始资产或人工默认设置。可运行 scripts/browser-expression-overlap-smoke.mjs 复查实际渲染，截图与结果保存到本机忽略 data/eye-overlap-*。

等待时不再自动疑惑：主播讲话或导演判断时轻微倾听，生成回复时自然待机。问号仍可由模型或人工明确选择；模型提示要求按具体语境使用，不因收到一句话、一个问题或弹幕就固定疑惑。表情自然度需要真实试播观察。

表情停留修正：每段 ms 只表示过渡，另有可选 holdMs（0–1800 ms），省略默认 800 ms。表情到位后保持再切换，最后一段也保留；提示模型常用 800–1400 ms，短句减少换表情。修复前只有过渡、没有停留，所以短动作看起来一闪而过。

刷新控制台，在“更多设置”选择 DeepSeek 回复。右侧“找句话试试”新增“逗逗她：又在摸鱼？”和“夸夸她：吐槽真好笑”。使用人工接话可直接看回应；使用自动导演则由她判断是否回复或只做动作。想明确检查连续动作，可输入：“小鲸鱼，你是不是又在摸鱼？你一边解释，一边自己安排几个连贯的小动作给我看看。”然后发送并让她接话。

舞台下方显示动作名称和执行到第几段，聊天气泡保留本次表演意图。普通对话允许她选择不动作；模拟回复模式不会调用模型编排动作。

- 模型自行选择视线、眯眼、头部、身体、嘴角的幅度和顺序，以及四种已开放表情的强度。每次 1–4 段，过渡合计至多 4 秒，加停留总长至多 10 秒，AIRI 在本机平滑过渡并自动释放。不是新增一组固定组合按钮，也不是让模型逐帧计算。
- integrations/airi/motion-sequence.ts 是服务端与两个舞台共用的限制、校验和采样实现。只开放十个归一化控制轴，未开放任意 Cubism 参数、脚本、服装道具、尾巴或挥手控制。模型绑定本身不支持的形变仍做不出来。
- 直接回复先流出第一句，随后可携带隐藏的 act 控制段；控制内容不进入字幕、TTS 或历史。自动导演用同一次 participate 工具调用提交决定、公开回复和可选 motion，也可 react 只做无声反应。没有额外引入 MCP 服务或第二次动作推理请求，但增加了提示词与动作输出 token；尚无首声延迟的对照统计。
- 音频动作在对应播放开始后启动；若动作在语音已经开始后才到达，则当时启动。没有实现逐词对齐。嘴巴开合仍归音频，动作可以与口型并行。过期、打断、断联释放，旧话轮的迟到事件不能重启动作；保留期间的人工表情编辑。
- 桌面主进程也需要新协议，更新代码后要重启桌面开发窗口，仅刷新角色页面不够。安装器保留可重放源码，不只修改忽略的 vendor。

新增验证：根项目检查和 89 项测试通过；网页和桌面类型检查通过；修改文件 ESLint 通过；原 Live2D 两文件 26 项测试与自由动作采样 2 项测试通过。全仓检查仍有已有依赖阻断，不表示全仓通过。

真实 DeepSeek 回复试验成功编排“被吓一激灵”三段动作，并在网页实际 Cubism 参数与画面上执行。另一次真实导演工具调用选择 react，提交无声三段反应；该次单独工具决策未作为真人现场验收。开发中共用了 3 次真实回复请求和 1 次真实导演请求：前两次回复未通过完整执行验收，其中一次暴露控制结束标签变体，修复后补入所有分片边界的回归并实测通过。

桌面重新加载主进程后，实际四种基础表情、连续动作与恢复均通过，零页面错误，证据 data/whale-desktop-result.json。独立网页验证还覆盖连续强度、人工修改保留、打断、断联释放及零页面错误。合成输入、模拟 ASR/TTS 的原生语音测试确认实际模型口型与动作同时运行，按钮停声单次约 159 ms，停后口型为 0；不是真人麦克风、真实语音供应商或延迟统计验收。

本机证据：忽略的 data/free-motion-real-result.json、data/free-motion-reaction-result.json、data/airi-voice-browser-result.json 及 free-motion 截图。额外复测命令：

```powershell
# 网页舞台 5173 已运行；PLAYWRIGHT_MODULE 与下方原验证命令相同
& data/toolchains/node-v26.7.0-win-x64/node.exe scripts/browser-free-performance-smoke.mjs
& data/toolchains/node-v26.7.0-win-x64/node.exe scripts/browser-airi-voice-smoke.mjs --live2d --free-motion
& data/toolchains/node-v26.7.0-win-x64/node.exe --env-file-if-exists=.env scripts/desktop-live2d-smoke.mjs --free-motion
# 以下两项各调用一次真实 DeepSeek，使用本机忽略 .env
& data/toolchains/node-v26.7.0-win-x64/node.exe --env-file-if-exists=.env scripts/browser-free-performance-smoke.mjs --real
& data/toolchains/node-v26.7.0-win-x64/node.exe --env-file-if-exists=.env scripts/free-motion-planner-trial.mjs --real
```

## 运行包与设置

- 用户原始 ZIP 保持不变。scripts/prepare-live2d.ps1 从内层鼠控版生成 data/live2d/whale-airi.zip，登记原有 44 个 exp3 表情，将 LipSync 指向 ParamMouthOpenY，并保留原作者使用须知与按键说明。不执行包中脚本。
- 准备器拒绝覆盖已有适配包、拒绝不安全归档路径，先写临时文件再移动。资产及本机记录在忽略目录，不纳入项目 MIT 许可或 Git。
- 原作者标注 B站 @氵六青11272072；版权标注 @上善无形、@ZipZipPin。使用约束以包内原文为准，不能把本地接入当成模型再分发授权。
- scripts/patch-airi.mjs 将已存在的适配包复制到忽略的 AIRI public/cohost-whale.zip。后续重放会核对副本指纹，拒绝覆盖未知编辑。无本地模型包时保留原有模型。
- AIRI 表情功能默认关闭，本机已启用。网页默认缩放 0.45、Y 20；当前桌面缩放 0.35、Y 60。可以在 AIRI 的角色模型设置调整。
- 44 个表情均已发现，导演先使用四组经过验证的表情；没有把全部服装、桌面道具与装饰开放给 AI。8 个 motion3 文件保留但未登记自动播放，导入检查因此有一项“动作未引用”警告，零错误。DS娘表情包中的 GIF 尚未接聊天贴图。

本机排练的网页和桌面已关闭鼠标眼神跟随，刷新后继续关闭。自然眨眼、待机活动、表演和口型保留。

## 执行与恢复

实现保存在 integrations/airi/use-cohost-performance.ts，安装器同步网页和桌面。按模型已发现的表情名称及参数签名匹配，其他模型继续使用通用姿态，不盲写鲸鱼娘专属参数。

切换表情前恢复本桥写入的旧值。动作过期、恢复、打断、心跳断开或卸载时释放；只恢复同一模型中仍等于本桥写入值的参数，保留操作期间人工编辑。暂态表情不会写入永久默认值。音频口型最终控制嘴巴张开，表情不占用该参数。

等待 AIRI 原生角色卡完成初始化，导入选择同时保存到活动角色卡，刷新后保留。首次导入时，网页收音按钮等待模型准备，避免在默认角色刚就绪时提前开始收音，然后被模型替换中止。

## 首批固定表演验收（历史基线）

- npm run check、npm test：通过，81 项回归。
- AIRI stage-web 与 stage-tamagotchi typecheck：通过。修改的表演文件及回执契约 ESLint：通过。
- Live2D Vitest 两个相关文件：26/26 通过，包括姿态弹簧和动作/口型执行。
- scripts/browser-live2d-smoke.mjs：独立网页会话验证导入、44 个表情发现、四种表情切换、点头变化、过期、人工编辑保留、断联恢复和口型控制。截图确认完整角色及问号/感叹号；页面错误为零。刷新后保持同一模型，文件模型仅 1 个，没有重复导入。
- scripts/desktop-live2d-smoke.mjs：实际桌面窗口重启后仍选中鲸鱼娘，四种表情对应的 Cubism 参数实际为 1，恢复为 0，页面错误为零。
- scripts/browser-airi-voice-smoke.mjs --live2d：合成麦克风输入、模拟 ASR/TTS 供应商，实际 AIRI 采集/VAD/播放与鲸鱼娘口型。重启后复测音频分析与模型嘴巴峰值均约 0.698；打断到停止状态 186 ms（单次自动化测量），停止后嘴巴为 0。没有开启真人麦克风，没有付费模型调用。
- AIRI 全量 lint 未通过：文档站缺 @radix-ui/colors。全量 typecheck 未通过：scenarios-stage-tamagotchi-browser 无可执行的 vue-tsc。两项都是全仓环境阻断，不能写成全量检查通过。
- 浏览器控制台有 AIRI 连接初始化与测试主动断网的提示；未观察到模型、纹理或表情加载失败。

测试脚本的截图与 JSON 保存到本机忽略的 data/whale-*，密钥继续仅保存在忽略 .env。


本机复测命令（在项目根目录，使用已经安装的工具链）：

```powershell
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/amber/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
& data/toolchains/node-v26.7.0-win-x64/node.exe scripts/browser-live2d-smoke.mjs
& data/toolchains/node-v26.7.0-win-x64/node.exe scripts/browser-airi-voice-smoke.mjs --live2d
& data/toolchains/node-v26.7.0-win-x64/node.exe --env-file-if-exists=.env scripts/desktop-live2d-smoke.mjs
```

网页测试要求 5173 舞台运行。桌面测试要求使用 APP_REMOTE_DEBUG=true、APP_REMOTE_DEBUG_PORT=9250 启动桌面，且当前没有收音或回复。语音模拟测试还需要本机忽略的 voice-fixture.wav 和 siliconflow-voice-trial.wav 样本。

## 后续

下一轮再选择少量脸红、眨眼、手势等原生表演，逐个验证动画是否会覆盖口型。句子级节奏、完整道具动画、表情贴图与更丰富动作尚未做。真人语音准确率、自然话轮和主观表演效果仍需要实际试播。