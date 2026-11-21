# 录音终端与调查队的对时记录

架设地点、设备与记录均为合成资料。录音为测试音，不含现场人员、动物或地点识别信息。

使用 Node.js 22.23.4。执行 `npm ci` 后运行 `npm start`，资料源默认监听本机 4173 端口，可用 `PORT` 指定端口。

`GET /sessions` 和 `GET /clock` 是可浏览的资料入口。`GET /ready` 或 `GET /health` 返回当前发布序号和总发布次数。`PUT /replay` 接受 JSON `{"step":1}`，用于在联调时将来源切到指定发布时刻。发布序号从 0 开始。每次发布只列变化的来源，应答沿用上一轮存在且未被替换的地址。收到 404 并不代表之前的历史资料从业务上被撤回。重新启动服务从第 0 次发布开始。

/detector 记录待调取窗口，参考时钟是毫秒整数，窗口右端不包含。/sessions 有录音会话内的样本数、采样率、起始设备 tick 和下载 URL。设备 tick 为毫秒。/clock anchors 的每项为 [tick,参考时钟,最大误差]。anchor 之间的名义时钟线性变化，maxError 给出本段额外误差，区间外没有可信换算。slices 列出实际存储连续区间，缺号表示来源明确没有该段。
/terminal 状态中的 budget 以本次出车可取的音频字节计。PCM 为有符号 16 位、小端、单声道。取件按 HTTP Range 字节定位，返回 Content-Range；部分旧会话会返回 410，临时断连返回 503。/deliveries 保存已经交付的窗口和原件范围。

会话的 acquisitionHint 给值班员粗略的可落入参考时段和最晚留存车次，不能据此归属样本。terminal 的 trip 是正在执行的出车号。未提供提示的会话只有实际对时记录可用于查询。

调查站独立保存已经交付的原始样本。deliveries.files 的 archive 返回曾交付的片段字节，frames 仍是该片段在终端原件内的位置，digest 校验该片段本身。终端原件的 410 不会撤销调查站已保留的文件。

运行 `npm test` 可校验资料源实际应答。样本内容存放在 `samples/`，开发时通过各来源的本地地址进行联调。

## 采集器（collector/）

采集器是调查站侧的 Node.js 程序，负责把鉴听窗口翻译成有限字节下的领取计划，并把每次出车的证据留在本地。模块划分：

- `collector/clock.mjs`：设备 tick 与参考时钟的线性换算。anchor 之间线性插值，误差在两端 anchor 误差间线性变化并叠加本段 `maxError`；anchor 覆盖域外不给任何可证实归属。
- `collector/intervals.mjs`：半开整数帧/字节区间的交、并、差。
- `collector/planner.mjs`：窗口×原件交叠判定、同原件合并、预算分配、三态分类。
- `collector/source-client.mjs`：HTTP Range 取件，区分 `offline`(503 可重试)、`retention`(410 终态无机会)、`gap`(416/切片缺号，从未录到)。
- `collector/store.mjs`：本地留存。真实取回的片段按帧位置存盘，附摘要；缺样、掉线、留存只落观察标记，绝不写填充音。
- `collector/collector.mjs`：一次出车的编排与 `pendingView`/`refetchDelivery`。
- `collector/cli.mjs`：命令行入口。

业务规则落点：

1. **共用领取的边界**：只有 `device + boot + file` 完全相同的交叠帧才合并成一份动作；终端重启复用旧文件名时 boot 不同即视为不同原件，不会合成一份。
2. **预算优先序**：`priority` 数值大的窗口先满足；同一原件内可证实帧先于待判帧；交叠窗口的公共帧只领一次，动作的 `serves` 标注全部受益窗口。
3. **待判保全**：对时锚尚未发布时，只凭 `acquisitionHint` 判断，若原件在下次出车前过期且可能落入高优先窗口，先整段保全并标 `pending`；补锚后只把可证实帧计入交付，未确定部分留在 `provisionalFrames`，不冒充已交付。
4. **补锚复用**：新对时修订改变相交范围后，先查本地已持有帧，已领字节直接复用，只对缺口发 Range 请求。
5. **三种取不到严格区分**：`gap`（来源 slices 缺号，从不重试）、`offline`（终端掉线，下次出车可重试，窗口不结项）、`retention`（410 留存覆盖，终态；调查站已归档片段仍可复取）。
6. **版本与复取**：同一窗口每次出车形成一个交付版本，`refetch` 可复取任意历史版本；`digest` 是本地复取字节的实际摘要，`sourceDigest` 保留来源登记摘要。

命令（先 `npm start` 启动资料源）：

```bash
npm run trip -- --origin http://127.0.0.1:4173 --state ./.intake-state   # 执行一次出车
npm run report -- --state ./.intake-state                                # 最近一次出车结项
npm run pending -- --state ./.intake-state                               # 可补/缺样/留存/掉线视图
npm run refetch -- --delivery D-3 --state ./.intake-state                # 复取某次交付
```

状态目录中的 `state.json` 是台账，`fragments/` 是真实片段字节；删除状态目录即回到未出车状态。
