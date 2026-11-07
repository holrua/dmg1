# 🎬 dmg — موقع دمج الفيديوهات مع API عامة

> **عربي تجريبي مباشر:** [https://dmg1.vercel.app](https://dmg1.vercel.app)

ارفع فيديوهاتك **برابط** أو **من جهازك**، رتّبها، وادمجها في **فيديو واحد بجودة عالية** (MP4 · H.264 · CRF 18 · حتى 1080p). كل شيء يُحفظ في قاعدة بيانات **Turso** ويُحذف **تلقائيًا بعد 24 ساعة**. واجهة برمجية **API عامة بدون تسجيل دخول** للمطورين، جاهزة للنشر على **Vercel**.

---

## ✨ المزايا

- **دمج بالترتيب**: ترتيب القائمة = ترتيب الدمج، مع إعادة ترميز موحّدة (نفس الدقة/الإطارات/الترميز) لنتيجة متصلة بدون تقطيع.
- **جودة عالية**: H.264 + AAC (192k)، CRF 18، دقة حتى 1080p، 30 إطار/ثانية، `+faststart` للتشغيل الفوري على الويب.
- **مدخلان**: روابط مباشرة (عبر الموقع أو الـ API) أو رفع ملفات من الجهاز (رفع مجزأ 4MB يتجاوز حدود حجم الطلب).
- **API عامة** بدون حساب: أنشئ مهمة → نفّذ الدمج → استلم رابط الفيديو النهائي.
- **حذف تلقائي بعد 24 ساعة**: تنظيف دوري عند كل طلب + Cron يومي، مع إمكانية حذف فوري عبر `DELETE`.
- **قابل للتعديل**: كل الحدود (عدد الفيديوهات، الأحجام، المدة، سرعة الترميز) عبر متغيرات بيئة.

## 🧱 البنية

```
المتصفح / المطور
   │  POST /api/jobs            (روابط أو وصف ملفات)
   │  POST /api/upload          (أجزاء الملفات من الواجهة)
   │  POST /api/jobs/<id>/process
   ▼
Vercel Serverless Functions (Node.js)
   │  تنزيل المصادر → ffmpeg (ffmpeg-static) → تخزين مجزأ
   ▼
Turso (libSQL) ── jobs / sources / source_chunks / output_chunks
   │  Blobs مجزأة 2MB + انتهاء صلاحية بعد 24 ساعة
   ▼
GET /api/jobs/<id>/video  ← بث الفيديو الناتج (يدعم Range)
```

## 🚀 النشر على Vercel (خطوة بخطوة)

1. ادخل [vercel.com](https://vercel.com) → **Add New → Project** → اختر مستودع `holrua/dmg`.
2. قبل الضغط على Deploy، افتح **Environment Variables** وأضف:

   | المتغير | القيمة |
   | --- | --- |
   | `TURSO_DATABASE_URL` | `libsql://merger-oklamnos.aws-us-east-1.turso.io` |
   | `TURSO_AUTH_TOKEN` | (التوكن الذي أنشأته من Turso) |

3. اضغط **Deploy**. بعد الانتهاء سيعمل الموقع على `https://<project>.vercel.app`.
4. (يُنصح) بعد التأكد أن كل شيء يعمل، **جدّد توكن Turso والتوكن الشخصي على GitHub** لأنهما تم تبادلهما في محادثة: توكن جديد من [app.turso.io](https://app.turso.io) ثم حدّثه في Vercel → Settings → Environment Variables.

> ملاحظة: `vercel.json` يضبط `maxDuration = 300` ثانية للدوال (متاح على الخطة المجانية مع Fluid Compute). إذا رفض النشر هذه القيمة، خفّضها إلى `60`.

## 🔌 التوثيق البرمجي (API) — بدون تسجيل دخول

### 1) إنشاء مهمة دمج

```bash
curl -X POST https://dmg1.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
```

الاستجابة:

```json
{
  "jobId": "abc123",
  "status": "queued",
  "statusUrl": "https://dmg1.vercel.app/api/jobs/abc123",
  "processUrl": "https://dmg1.vercel.app/api/jobs/abc123/process",
  "expiresAt": "2026-11-08T13:00:00.000Z"
}
```

### 2) تنفيذ الدمج واستلام الرابط النهائي

```bash
curl -X POST https://dmg1.vercel.app/api/jobs/abc123/process
```

```json
{
  "jobId": "abc123",
  "status": "done",
  "videoUrl": "https://dmg1.vercel.app/api/jobs/abc123/video",
  "downloadUrl": "https://dmg1.vercel.app/api/jobs/abc123/video?download=1",
  "size": 734593,
  "duration": 4.0,
  "resolution": "1280x720",
  "expiresAt": "2026-11-08T13:00:00.000Z"
}
```

الطلب متزامن (يستغرق حسب الأحجام). إذا كانت المهمة قيد التنفيذ بالفعل ستحصل على `202` — راقب `statusUrl`.

### 3) متابعة الحالة (اختياري)

```bash
curl https://dmg1.vercel.app/api/jobs/abc123
```

### النقاط المتاحة

| Method | Endpoint | الوصف |
| --- | --- | --- |
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":[...]}` أو `{"sources":[{kind:"url"\|"file",...}]}` |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج → الرابط النهائي |
| `GET` | `/api/jobs/<id>` | حالة المهمة والتقدّم (0-100) والرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الفيديو الناتج (`?download=1` للتحميل، يدعم `Range`) |
| `DELETE` | `/api/jobs/<id>` | حذف المهمة وكل بياناتها فورًا |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (يستخدمه الموقع) |
| `GET` | `/api/config` | حدود الخدمة الحالية |
| `GET` | `/api/cron` | تنظيف المهام المنتهية (يستدعيه Cron يوميًا) |

جميع النقاط ترسل ترويسات CORS مفتوحة، والأخطاء بصيغة `{"error":"..."}`.

## ⚙️ متغيرات البيئة

| المتغير | الافتراضي | الوصف |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | — | **مطلوب** رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | — | **مطلوب** توكن قاعدة Turso |
| `MAX_SOURCES` | `10` | أقصى عدد فيديوهات لكل مهمة |
| `SOURCE_MAX_MB` | `200` | أقصى حجم لكل رابط/ملف مصدر |
| `OUTPUT_MAX_MB` | `150` | أقصى حجم للفيديو الناتج |
| `MAX_TOTAL_DURATION_SEC` | `600` | أقصى مدة إجمالية للمصادر |
| `FFMPEG_PRESET` | `medium` | سرعة الترميز (`veryfast` أسرع بحجم أكبر) |

## 💻 التشغيل محليًا

```bash
cp .env.example .env       # ثم ضع بيانات Turso الحقيقية
npm install
npm run dev                # http://localhost:3000 (يحاكي بيئة Vercel)
npm test                   # اختبارات الوحدة + دمج حقيقي + Turso
npm run smoke              # اختبار HTTP كامل عبر خادم التطوير
```

## 📏 حدود وضوابط

- روابط الفيديو يجب أن تكون **عامة ومباشرة** (تُنزَّل من الخادم — لا مشاكل CORS).
- **ملفات تجريبية جاهزة** للتجربة الفورية: `https://dmg1.vercel.app/test/a.mp4` و `https://dmg1.vercel.app/test/b.mp4`
- المخرجات تُخزَّن كـ Blobs مجزأة في Turso؛ الخطة المجانية 5GB — راقب الاستهلاك إن زاد الاستخدام.
- الخطة المجانية على Vercel مع Fluid Compute تسمح حتى 300 ثانية للدالة: اجعل مجموع مدد الفيديوهات معقولًا (أفضل أداء حتى ~5 دقائق مصادر عند `medium`، أو استخدم `veryfast`).
- لا يوجد تسجيل دخول عمدًا (طلب الخدمة العامة)؛ الحدود + الحذف التلقائي هما خط الحماية.

## 📄 الترخيص

MIT
