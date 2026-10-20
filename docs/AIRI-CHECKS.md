# AIRI 全仓检查（Windows）

2026-10-15，固定提交 `34576c19f618a04e616657089f0688a8637873f2`。

## 安装与运行

此前只安装了 stage-web/stage-tamagotchi 的依赖子集，全仓 lint/typecheck 所需的其他 workspace 工具没有全部链接。本次按已有锁文件安装全部 75 个 workspace；没有升级 AIRI 或改动其依赖锁文件。

使用项目固定 Node 26.7.0 / pnpm 11.24.0：

```powershell
./scripts/local.ps1 setup:airi:checks
./scripts/local.ps1 check:airi
```

`setup:airi:checks` 运行完整的 frozen-lockfile / ignore-scripts 安装，并重放检查补丁；不会 reset 已有源码。浏览器测试还需执行一次 `pnpm exec playwright install chromium`。安装缓存和 Windows 符号链接测试需要正常的本机文件权限；受限沙箱出现的 EPERM 不等于产品代码失败。

`check:airi` 依次运行 typecheck、lint、build:packages，以及上游 test:run 的六个测试组。某一组失败后仍继续其他组，最终返回非零；不会跳过 IPv6 测试。单独运行可用 `node scripts/check-airi.mjs typecheck`、`lint`、`build`、`test` 或 `test-ui` 等组名。

日志位于忽略的 `data/airi-check-*.log`；每次运行的汇总在 `data/airi-checks-summary.json`。后者只代表该次选择的步骤，不能用单项成功推断全仓成功。

工具链统一设置 `pnpm_config_enable_global_virtual_store=false`，并将 `pnpm_config_verify_deps_before_run=error`。pnpm 11 在 CI 和日常运行中的默认布局可能不同，保持一致避免运行检查时隐式重装依赖。嵌套 pnpm 调用使用本机固定版本的 launcher。测试使用 `--no-experimental-webstorage`，与上游 CI 对 Node 环境的要求一致。

## 本次验证结果

| 检查 | 结果 |
| --- | --- |
| 全仓 typecheck | 55/55 任务通过，包含升级后的共享状态契约 |
| 全仓 lint | 0 errors，683 warnings；未把 warnings 当成全部修复 |
| build:packages | 34/34 任务通过 |
| 根测试组 | 2601 通过，4 个上游跳过，1 个 IPv6 环境失败 |
| 桌面浏览器 | 109 通过 |
| 网页浏览器 | 1 通过 |
| 共享页面 | 14 通过 |
| stage-ui | 1169 通过；后续新增状态连接测试单独 2/2 通过 |
| Live2D 浏览器 | 25 通过 |
| 助播原型 | npm run check；npm test 186/186 通过 |

计数按测试组展示，不视为不重复的端到端场景数量。没有宣称打包了 Windows 安装包，或构建了所有平台的 Swift/Godot/.NET 原生项目。

唯一仍失败的测试是 auth 的 `uses forwarded client IP over IPv6 gateway socket`：连接 `::1` 返回 EACCES。普通本机权限下最小 Node TCP 程序也能复现。用户确认代理/VPN 可能开启 TUN；这是候选原因，尚未通过关闭 TUN 对照确认。未改变防火墙或代理，未删除/跳过原测试。可在用户方便时暂时关闭 TUN，重跑该测试和最小回环程序。

## 修复与可重放来源

- `scripts/patch-media.mjs`、`scripts/patch-desktop.mjs`：修复生成文件的尾部空行和导入顺序两个 lint error。
- `integrations/airi/verification.patch`：Windows 路径断言、CRLF 静态文件断言、UnoCSS 测试扫描路径规范化、明确中英文语言用例、首次懒加载设置页等待。保留真实组件、鉴权、符号链接与原有行为断言。
- `scripts/patch-checks.mjs`：验证固定提交并幂等应用上述补丁，遇到冲突停止，不覆盖未知修改。
- `scripts/airi-toolchain.mjs`、`scripts/check-airi.mjs`：固定依赖布局、工具版本、测试环境和完整检查顺序。

浏览器日志仍含上游 ResizeObserver、测试路由缺失等警告，测试未以此失败；本次没有通过屏蔽错误处理来消除它们。
