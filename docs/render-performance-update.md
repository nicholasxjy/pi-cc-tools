渲染性能补充优化

本轮移除了 `edit`、`write`、`apply_patch` 的参数渐进预览。参数流入时只显示工具名和路径，`edit`、`apply_patch` 在参数完整后生成 diff，`write` 在写入完成后生成 diff。完整 diff 的语法高亮、词级标记、展开和分栏继续保留。

已完成的预览按原始内容和内容版本复用解析结果，避免每次失效、展开或缩放时重新拼接和哈希全文。内容版本也用于隔离过期的异步预览任务。恢复历史记录时，最终工具结果现在会完成摘要缓存，避免重复统计文件行数。分组内工具更新直接清除分组布局缓存，省去重复的主题失效检查；实际主题切换仍执行完整失效流程。

生产代码净减少 40 行，未新增依赖或用户配置。

使用同一份 `scripts/benchmark-performance.mts`，分别对原版本 `7ad6743` 和当前工作区运行三个独立 Node 进程。新增场景每个进程执行 100 次操作，下表取三个进程平均耗时的中位数。原版本的隔离副本保留了工作区已有的 `extensions/bash-intent.ts` 改动，避免将其差异混入比较。测量期间未并行运行测试套件。

环境：macOS arm64、Node v26.13.0、100 列；统一 diff，关闭终端主题同步。参数流场景包含 `updateArgs()` 和组件渲染，失效重绘场景包含 `invalidate()` 和组件渲染。

| 场景 | 优化前 | 优化后 | 耗时下降 |
| --- | ---: | ---: | ---: |
| write：50,000 行参数流更新 | 1.512 ms | 0.018 ms | 98.8% |
| write：60 KB diff 失效重绘 | 0.139 ms | 0.019 ms | 86.6% |
| edit：50,000 行参数流更新 | 1.285 ms | 0.016 ms | 98.7% |
| edit：60 KB diff 失效重绘 | 0.128 ms | 0.025 ms | 80.2% |
| apply_patch：50,000 行参数流更新 | 1.382 ms | 0.101 ms | 92.7% |
| apply_patch：60 KB diff 失效重绘 | 0.115 ms | 0.013 ms | 88.8% |

这些是组件处理和布局耗时，不能换算为整个程序的帧率或真实终端吞吐。原有基准场景及全部六轮的 wall time、CPU 时间保存在 [render-performance-results.json](render-performance-results.json)。

回归检查还确认：60 KB 预览在 10 次无变化重绘中，全文哈希字符访问从约 600,000 降至 0；恢复的 write 记录在 10 次无变化重绘中，全文分割从 10 次降至 0。测试覆盖原地参数更新、旧异步任务隔离、精确文件写入、多个编辑块、错误显示、主题切换、Unicode、缩放和展开。

验证结果：

- `npm test`：243 项通过，0 项失败。
- `npm run typecheck`：通过。
- `npm run pack:dry-run`：通过。
- `git diff --check`：通过。
- 全屏鼠标和复制脚本：使用已安装的 Pi 1.5.2，通过全部检查。测试使用临时符号链接适配该安装的依赖提升布局，未修改安装目录。

复测：

```bash
npm test
npm run typecheck
node --experimental-strip-types scripts/benchmark-performance.mts
```

确认 Pi 加载本地工作区扩展后，运行 `/reload` 或重启使改动生效。本轮未测量长时间运行的真实终端帧率、RSS 或耗电。
