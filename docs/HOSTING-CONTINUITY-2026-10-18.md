# 持续主持、口头托管和静默接播

用户反馈自主模式很快停下，希望说“你先播着，我去忙点别的”或一段时间没人说话就能自己接播。截图显示“主持状态已变化，请重试”。

## 原因和实现

- 原默认12次判断、12轮和10分钟无输入会结束活动；模型listen/0没有后续唤醒。现在默认continuous=true，取消这些总量上限，有限模式保留用于回归。
- 主动开启收音/互动后，默认连续安静30秒再观察。正常显式计划保留；没有计划或0使用静默观察。声音实际播完后才计时，观众等待不包含角色讲话时间。仅开窗口不发声。
- speech-start取消待执行计划。没有最终转写的声音结束后仍可重新计时，避免一次噪声永久撤销唤醒。讲话、播放、静音时不触发。
- hostingControl=start/pause复用当前导演流式调用。只有当前主播最终输入可执行，并校验输入编号、时效和主持修订；观众、旧任务和临时识别不能操作。引用/假设拒绝控制，否定句额外禁止start。此检查刻意保守，带引用的混合指令可以直接改说一句“你继续主持”。
- 缺失收尾和临时判断/播放失败使用30/60/120秒退避；第4次连续失败或密钥错误暂停。成功决定或新输入清除连续错误计数。失败不回放旧台词，后续按新现场重新判断。
- 主持控制通过controlRevision区分人工控制与后台revision。普通输入/播放状态变化允许旧快照按钮执行；人工暂停/停止之后的旧请求不能恢复主持。重复的继续请求在已运行时直接成功。
- 人工停止、关闭自主安排、静音、舞台断线、换角色仍撤销安排。语音识别和TTS链路未修改，不自动开启麦克风。

## 验证

- `npm run check`、`npm test`452项通过；AIRI状态同步Vitest 2项通过；全仓类型55/55通过，lint 0错误/683原有警告；固定桌面构建20261018T102019849Z-d596aa48成功。
- Node模拟覆盖25轮、每轮25秒播放和2秒间隔，合计675秒，无新输入仍能继续。还有30秒边界、无转写声音、暂停/静音/断线取消、退避耗尽、引用否定防误开、HTTP口头恢复与按钮竞态。
- 真实DeepSeek隔离文本10例：首轮9/10，引用句被模型误判为start；新增执行前引用/假设/否定检查并明确模型提示后，复核10/10。包含4种托管说法、否定、引用、假设、普通续讲、观众命令以及超过原预算的静默接播。
- 网络沙箱第一轮10例均network失败，单独保留。没有丢弃不合格样本或把网络失败算成模型通过。
- 证据：`data/hosting-autonomy-trial-1792318607317/report.json`（网络失败）、`data/hosting-autonomy-trial-1792318626444/report.json`（引用误开）、`data/hosting-autonomy-trial-1792318757187/report.json`（修正后）。测试脚本：[hosting-autonomy-trial.mjs](../scripts/hosting-autonomy-trial.mjs)。
- 真实模型试验没有ASR、TTS或生产聊天写入，未验证真人长时间直播、物理听感或所有近义说法。生成内容仍出现未观察到的拟人经历/事实断言，这不属于本次托管判断通过的结论。

## 源码和部署

[Hosting状态机](../apps/cohost/hosting.mjs)、[导演执行](../apps/cohost/participation.mjs)、[模型协议](../apps/cohost/participation-model.mjs)、[HTTP控制](../apps/cohost/server.mjs)、[回归](../tests/hosting.test.mjs)、[HTTP回归](../tests/airi-voice.test.mjs)。桌面文案/状态契约保存在integrations/airi和packages/cohost-contracts，通过已有补丁重放，vendor不是唯一副本。

后端291632已更新，当前主持off、关麦；桌面已关闭，未代用户打开，下次启动采用新产物。备份`data/hosting-continuity-deploy-20261018/session.before.sqlite`；前后记录同目录before.json/after.json。300条聊天按既有重启恢复规则核对一致，全部持久配置、角色和.env指纹一致。首次校验比较包含临时session/revision的整体room哈希失败；改为按既有RoomJournal恢复规则逐条比较后通过，没有恢复或覆盖数据库。

最终检查结果见[当前状态](STATUS.md)。
