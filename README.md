# 设施巡检资料

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、FlatGeobuf 按区域结构化采集和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t spatial-feature-reader:local .
docker run --rm --network none spatial-feature-reader:local npm test
docker run --rm --network none spatial-feature-reader:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 按区域结构化采集

`POST /v1/intakes` 传 `{"mode":"structured","region":[minX,minY,maxX,maxY]}` 即可按闭合矩形领取子集。服务先沿 FlatGeobuf 自带的 packed Hilbert R-tree 索引裁剪候选要素，再对候选做真实几何相交判断：边界接触保留、仅包围盒相交排除、洞内不算；无索引文件（indexNodeSize=0）改为要素区完整扫描并在 issues 中说明。所有读取只发 HTTP Range 请求并逐次记录字节范围与摘要，首个 ETag 之后的请求一律带 If-Match：远端不理会 Range 时收件为 partial 并附 range-ignored 问题，来源中途换版时收件为 rejected，不会拼出看似正常的数据。coverage 说明索引裁剪、扫描方式与实际读取字节，evidence 保留每次来源访问的范围、状态、ETag 与 SHA-256 证据。`STRUCTURED=1 npm test` 仍可运行，结构化检查已默认纳入 `npm test`。
