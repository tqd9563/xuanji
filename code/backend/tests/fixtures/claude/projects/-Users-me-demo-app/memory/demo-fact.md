---
name: demo-fact
description: 查数返空先自查集群与分区
metadata:
  type: feedback
---

BBX 查询返空的第一原因是集群选错。

**Why:** 曾把国际服数据当国服查。

**How to apply:** 先跑 get_qe_clusters 确认集群。关联 [[metric-caliber-first]] 与 [[offline-eval]]。
