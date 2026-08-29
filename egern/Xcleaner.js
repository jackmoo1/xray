(function () {
try {
if (typeof $response === "undefined" || !$response.body) {
$done({});
return;
}

```
    // 仅验证 JSON 是否能够正常解析，不修改任何数据
    JSON.parse($response.body);

    // 原样返回
    $done({
        body: $response.body
    });

} catch (e) {
    // 出错也原样放行
    $done({
        body: typeof $response !== "undefined" ? $response.body : ""
    });
}
```

})();
