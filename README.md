## xray一键脚本



## 脚本集合内容：

-    安装Xray-VMESS
-    安装Xray-VMESS+mKCP
-    安装Xray-VMESS+TCP+TLS
-    安装Xray-VMESS+WS+TLS
-    安装Xray-VLESS+mKCP
-    安装Xray-VLESS+TCP+TLS
-    安装Xray-VLESS+WS+TLS(可过cdn)
-    安装Xray-VLESS+TCP+XTLS
-    安装trojan
-    安装trojan+XTLS



## 一键脚本 


`wget --no-check-certificate "https://github.com//jackmoo1/xray/raw/main/xray.sh" && chmod +x xray.sh && ./xray.sh`

快捷启动`./xray.sh`


## 2021.9.8

- 修复域名无法解析 
- 修复xray无法更新 


## 2021.10.13
-  XTLS协议的配置，添加路由分流规则
-  路由规则文件可参考[**Loyalsoldier**](https://github.com/Loyalsoldier/v2ray-rules-dat)大佬的说明和使用方法
-  路规则文件`geoip.dat`和`geosite.dat`所在位置`/usr/local/share/xray`，可自行替换更新






