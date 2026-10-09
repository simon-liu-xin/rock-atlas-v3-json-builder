# 工程约定

输出必须验签、校验 hash 与计数。先写 immutable 文件，后切换 current；
保持 generation 固定，不能把多源共现伪装成历史影响关系。

## Testing

运行 `npm run check`。发布与前端同步必须先验证活动 root 和所有对象。
私钥、Token、SQL dump 与生成输出不进入 Git。
