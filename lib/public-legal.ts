/** Public drafts describe implemented behaviour; changes to data handling need their own approved cycle. */
export type PublicLegalSection = { id: string; title: string; paragraphs: readonly string[] };
export type PublicLegalDocument = {
  title: string;
  introduction: string;
  relatedHref: string;
  relatedLabel: string;
  sections: readonly PublicLegalSection[];
};

export const PUBLIC_LEGAL_UPDATED = { iso: "2026-10-16", label: "16 Oktober 2026" };
export const PUBLIC_LEGAL_DRAFT = "Draf untuk ditinjau pengelola. Nama badan hukum dan alamat pengelola, serta pengadilan yang dipilih, perlu dikonfirmasi sebelum uji coba eksternal.";

const operator: PublicLegalSection = {
  id: "pengelola",
  title: "Pengelola layanan",
  paragraphs: [
    "Buku dikelola oleh Right Jet (right-jet.com), selanjutnya disebut pengelola. Pertanyaan, keluhan, dan permintaan terkait data diajukan melalui kontak pengelola di akhir halaman ini.",
    "Untuk data permintaan uji coba dan data akun anggota, pengelola menentukan tujuan dan cara pemrosesannya. Untuk isi pembukuan yang diunggah organisasi, termasuk data klien dan pihak lain di dalamnya, organisasi yang menentukan tujuannya dan pengelola memprosesnya atas nama organisasi untuk menyediakan Buku.",
  ],
};

const trialRequest: PublicLegalSection = {
  id: "permintaan-uji-coba",
  title: "Data permintaan uji coba",
  paragraphs: [
    "Formulir uji coba meminta nama, email kerja, nama organisasi, dan jenis organisasi (kantor akuntan atau perusahaan). Keempatnya wajib. Nomor WhatsApp dan catatan bersifat opsional. Buku juga mencatat alamat IP bila tersedia untuk mencegah penyalahgunaan dan membatasi permintaan.",
    "Data permintaan dipakai untuk meninjau kelayakan uji coba, menghubungi pemohon, dan menyiapkan undangan jika disetujui. Catatan permintaan terpisah dari catatan pembatasan permintaan berdasarkan email dan IP. Jawaban terima kasih tidak berarti akses sudah disetujui.",
  ],
};

const trialAccess: PublicLegalSection = {
  id: "akses-uji-coba",
  title: "Persetujuan dan akhir uji coba",
  paragraphs: [
    "Buku meninjau dan menyetujui permintaan sebelum mengirim undangan. Akses diberikan untuk organisasi dengan tanggal mulai dan tanggal berakhir yang ditentukan Buku; perpanjangan perlu disepakati dengan pengelola.",
    "Setelah masa uji coba berakhir, anggota yang masih memiliki izin dapat membaca data dan mengunduh laporan. Perubahan data dan penggunaan AI tidak tersedia. Data ruang kerja tidak otomatis dihapus saat uji coba berakhir. Akses dapat ditutup bila dicabut atau organisasi ditangguhkan; masa baca setelah uji coba bukan janji akses selamanya.",
  ],
};

const support: PublicLegalSection = {
  id: "akses-dukungan",
  title: "Akses dukungan Buku",
  paragraphs: [
    "Untuk menelusuri masalah, petugas dukungan Buku dapat membuka ruang kerja organisasi dalam mode hanya baca, sebagai salah satu anggotanya. Sesi dibatasi hingga 60 menit, memerlukan login dengan verifikasi dua langkah, dan dimulai dengan alasan yang dicatat. Petugas tidak dapat mengubah pembukuan melalui sesi ini.",
    "Organisasi tidak diberi pemberitahuan setiap kali sesi dukungan dibuka. Buku mencatat sesi, halaman yang dibuka, dan unduhan. Catatan ini disimpan oleh Buku, bukan ditampilkan sebagai riwayat aktivitas organisasi.",
  ],
};

const retention: PublicLegalSection = {
  id: "penyimpanan-data",
  title: "Penyimpanan dan permintaan penghapusan",
  paragraphs: [
    "Saat ini belum ada penghapusan terjadwal. Catatan permintaan uji coba dan catatan pembatasan permintaan tetap tersimpan sampai penghapusan dilakukan oleh pihak yang berwenang. Jendela pembatasan satu jam hanya mengatur jumlah permintaan; jendela itu tidak menghapus catatan yang tersimpan.",
    "Data ruang kerja tetap tersimpan setelah uji coba berakhir. Hubungi pengelola untuk meminta akses, koreksi, atau penghapusan data. Permintaan ditinjau sesuai hak yang berlaku, kewenangan pemohon, serta kewajiban penyimpanan hukum atau akuntansi. Buku tidak menjanjikan tanggal penghapusan otomatis atau fitur hapus mandiri yang belum tersedia.",
  ],
};

export const PUBLIC_TERMS: PublicLegalDocument = {
  title: "Syarat penggunaan",
  introduction: "Ketentuan uji coba Buku untuk kantor akuntan dan perusahaan. Baca juga kebijakan privasi untuk memahami pemrosesan data.",
  relatedHref: "/kebijakan-privasi",
  relatedLabel: "Baca kebijakan privasi",
  sections: [
    operator,
    {
      id: "penggunaan-buku",
      title: "Pembukuan tetap ditinjau manusia",
      paragraphs: [
        "Buku membantu mengolah rekening koran dan dokumen menjadi Buku Besar, Neraca Saldo, Laba Rugi, Neraca, dan proses Tutup Buku. Organisasi dan akuntannya tetap bertanggung jawab memeriksa sumber, klasifikasi, jurnal, serta laporan sebelum dipakai.",
        "AI memberi usulan dan penjelasan; AI tidak memposting jurnal secara otomatis. Hasilnya dapat keliru dan perlu ditinjau. Ketersediaan AI mengikuti pengaturan dan batas penggunaan Buku. Buku tetap dapat digunakan dengan aturan dan memori tanpa AI.",
      ],
    },
    trialRequest,
    trialAccess,
    {
      id: "biaya",
      title: "Biaya",
      paragraphs: [
        "Uji coba tidak dikenakan biaya, kecuali disepakati lain secara tertulis. Penggunaan berbayar setelah uji coba memerlukan kesepakatan terpisah yang menyebutkan harga, cakupan, dan jangka waktunya. Buku tidak menagih apa pun secara otomatis.",
      ],
    },
    {
      id: "akun-dan-dokumen",
      title: "Akun, izin, dan dokumen",
      paragraphs: [
        "Gunakan data yang Anda berhak unggah dan bagikan, termasuk data klien atau pemilik rekening. Organisasi mengatur anggota, peran, dan penugasan klien. Jaga kredensial akun dan hubungi pengelola bila menduga ada akses tanpa izin.",
        "Jangan gunakan Buku untuk mengakses organisasi lain tanpa izin, mengganggu layanan, atau mengunggah materi melanggar hukum. Buku dapat mencabut akses atau menangguhkan organisasi untuk menangani penyalahgunaan dan masalah akses.",
      ],
    },
    {
      id: "kepemilikan-data",
      title: "Data tetap milik Anda",
      paragraphs: [
        "Dokumen, transaksi, jurnal, dan laporan yang dibuat dari data organisasi tetap menjadi milik organisasi atau kliennya. Pengelola memprosesnya hanya untuk menyediakan, mengamankan, dan mendukung Buku, tidak menjualnya, dan tidak memakainya untuk iklan.",
        "Laporan dapat diunduh dalam Excel dan PDF selama akses masih berlaku, termasuk masa baca setelah uji coba. Perangkat lunak, tampilan, dan merek Buku tetap milik pengelola; uji coba memberi hak memakai Buku, bukan hak atas perangkat lunaknya.",
      ],
    },
    support,
    retention,
    {
      id: "layanan-dan-perubahan",
      title: "Layanan dalam tahap uji coba",
      paragraphs: [
        "Fitur dan dukungan format dapat berubah selama uji coba. Pengenalan nama bank tidak berarti semua format bank tersebut didukung. Simpan dokumen sumber dan unduh laporan yang diperlukan; periksa hasil sebelum membuat keputusan akuntansi, pajak, atau bisnis.",
        "Perubahan ketentuan akan dicantumkan pada halaman ini dengan tanggal pembaruan. Hubungi pengelola bila Anda memerlukan penjelasan atau kesepakatan khusus sebelum menggunakan Buku.",
      ],
    },
    {
      id: "tanggung-jawab",
      title: "Batas tanggung jawab",
      paragraphs: [
        "Selama uji coba, Buku disediakan sebagaimana adanya. Pengelola berupaya menjaga ketersediaan dan ketepatan pengolahan, tetapi tidak menjamin layanan bebas gangguan atau hasil bebas kesalahan.",
        "Sejauh diizinkan hukum, pengelola tidak bertanggung jawab atas kerugian tidak langsung, kehilangan keuntungan, atau keputusan akuntansi, pajak, dan bisnis yang diambil tanpa meninjau sumber dan hasil pembukuan. Batasan ini tidak mengurangi hak yang menurut hukum tidak dapat dikecualikan, termasuk hak Anda sebagai subjek data pribadi.",
      ],
    },
    {
      id: "mengakhiri",
      title: "Mengakhiri penggunaan",
      paragraphs: [
        "Organisasi dapat berhenti memakai Buku kapan saja dan meminta penghapusan data melalui kontak pengelola, sebagaimana dijelaskan di bagian penyimpanan. Pengelola dapat mengakhiri uji coba pada tanggal berakhirnya, atau lebih awal untuk menangani penyalahgunaan, risiko keamanan, atau kewajiban hukum, dengan memberi tahu organisasi bila memungkinkan.",
      ],
    },
    {
      id: "hukum-dan-sengketa",
      title: "Hukum yang berlaku dan sengketa",
      paragraphs: [
        "Ketentuan ini tunduk pada hukum Republik Indonesia dan ditulis dalam bahasa Indonesia. Bila ada perselisihan, para pihak lebih dahulu menyelesaikannya secara musyawarah dalam 30 hari sejak salah satu pihak memberi tahu secara tertulis. Bila tidak tercapai, perselisihan diselesaikan melalui Pengadilan Negeri Jakarta Selatan.",
      ],
    },
  ],
};

export const PUBLIC_PRIVACY: PublicLegalDocument = {
  title: "Kebijakan privasi",
  introduction: "Cara Buku menggunakan data permintaan uji coba, akun, dan pembukuan. Halaman ini menjelaskan perilaku layanan saat ini.",
  relatedHref: "/syarat",
  relatedLabel: "Baca syarat penggunaan",
  sections: [
    operator,
    trialRequest,
    {
      id: "data-ruang-kerja",
      title: "Data akun dan ruang kerja",
      paragraphs: [
        "Ruang kerja menyimpan identitas anggota dan organisasi, peran dan penugasan klien, dokumen sumber, rekening koran, transaksi, jurnal, laporan, serta riwayat tindakan. Dokumen dan keterangannya dapat memuat nama, nomor rekening, dan informasi pribadi atau keuangan pihak lain.",
        "Data dipakai untuk menjalankan pembukuan, menjaga hubungan angka dengan sumbernya, mengatur izin, membantu pemulihan akun, serta menelusuri perubahan dan masalah layanan. Organisasi perlu memastikan memiliki dasar yang sah untuk memasukkan data klien dan pihak lain.",
      ],
    },
    {
      id: "tujuan-dan-dasar",
      title: "Tujuan dan dasar pemrosesan",
      paragraphs: [
        "Dasar pemrosesan disesuaikan dengan tujuan dan keadaan: langkah atas permintaan Anda sebelum layanan diberikan atau pelaksanaan perjanjian untuk uji coba dan pembukuan; kepentingan sah untuk keamanan, pencegahan penyalahgunaan, dan dukungan dengan mempertimbangkan hak Anda; serta kewajiban hukum bila berlaku. Persetujuan digunakan bila diperlukan oleh hukum untuk pemrosesan tertentu.",
        "Mengirim formulir berarti meminta Buku meninjau dan menghubungi Anda mengenai uji coba, sebagaimana dijelaskan di formulir. Untuk isi pembukuan, organisasi yang menetapkan dasar pemrosesan atas data klien dan pihak lain yang diunggahnya.",
      ],
    },
    {
      id: "pemrosesan-ai",
      title: "Bahan yang dikirim untuk tugas AI",
      paragraphs: [
        "Buku menggunakan penyedia AI pihak ketiga bila fitur AI diaktifkan. Bahan yang dikirim berbeda untuk setiap tugas. Usulan dan penjelasan perlu ditinjau manusia; AI tidak memposting jurnal secara otomatis.",
        "Klasifikasi mutasi mengirim penerima atau kata kunci transaksi, keterangan terbatas (hingga 80 karakter), arah uang masuk atau keluar, serta nama dan jenis usaha klien dan daftar kode/nama akun. Kolom nominal transaksi dan saldo tidak dikirim untuk tugas klasifikasi ini. Keterangan yang Anda unggah tetap dapat memuat angka atau identitas rekening.",
        "Pemetaan akun mengirim kode dan nama akun sumber, petunjuk jenis akun, serta konteks klien dan bagan akun tujuan. Tugas ini tidak mengirim nominal transaksi atau saldo.",
        "Analisis bukti dapat mengirim kutipan dokumen yang dibatasi beserta lokasinya dan konteks. Perencanaan jawaban atas pertanyaan mengirim pertanyaan dan konteks entitas/periode yang dibatasi. Bahan tersebut dapat memuat data pribadi dan keuangan; penghitungan jawaban dilakukan oleh Buku.",
        "Penjelasan Tutup Buku dapat mengirim kontrol yang ditandai, baris terkait beserta nominal, akun, dan konteks entitas. Catatan laporan manajemen mengirim fakta naratif yang dihitung Buku, beserta konteks klien, entitas, periode, dan mata uang; fakta itu dapat berisi angka laporan.",
        "Baca scan dengan AI mati kecuali Buku menyalakannya. Saat digunakan, gambar halaman dikirim ke penyedia untuk disalin. Gambar dapat memuat nama, nomor rekening, nominal, saldo, dan data pribadi atau keuangan lainnya. Kata sandi PDF tidak pernah dikirim ke penyedia AI. Sandi yang membuka file di halaman Unggah disimpan terenkripsi untuk klien itu saja, agar file bulan berikutnya tidak perlu diketik ulang; admin dapat menghapusnya di pengaturan klien. Sandi yang diketik di cara impor lain hanya dipakai untuk membuka file dan tidak disimpan.",
        "Karena bahan mengikuti tugasnya, tidak ada jaminan bahwa semua nominal atau identitas rekening selalu tinggal di Buku. Tanpa AI, fungsi pembukuan dengan aturan dan memori tetap tersedia.",
      ],
    },
    {
      id: "lokasi-dan-pihak-ketiga",
      title: "Lokasi layanan dan pihak ketiga",
      paragraphs: [
        "Server aplikasi dan basis data Buku berada di region Singapura. Lokasi ini berbeda dari pemrosesan oleh penyedia AI pihak ketiga; pemrosesan mereka tidak dijamin seluruhnya berlangsung di Singapura.",
        "Ketentuan penyimpanan dan pemrosesan penyedia AI perlu diperiksa sesuai penyedia yang digunakan. Draf ini tidak menjanjikan jangka retensi penyedia, larangan penggunaan untuk pelatihan, atau sertifikasi kepatuhan yang belum diverifikasi. Hubungi pengelola untuk penjelasan sebelum mengirim data yang memerlukan pembatasan khusus, termasuk transfer lintas negara.",
      ],
    },
    {
      id: "penerima-data",
      title: "Siapa yang menerima data",
      paragraphs: [
        "Pengelola memakai penyedia infrastruktur untuk menjalankan Buku: penyedia hosting aplikasi dan basis data, penyedia layanan login yang juga mengirim email undangan dan pemulihan akun, serta penyedia AI bila fitur AI diaktifkan. Mereka memproses data untuk menjalankan layanan tersebut, bukan untuk kepentingan sendiri dari pengelola.",
        "Data tidak dijual dan tidak dibagikan untuk iklan. Data dapat diungkapkan bila diwajibkan oleh hukum atau perintah instansi yang berwenang; pengelola akan memberi tahu organisasi bila diizinkan.",
      ],
    },
    {
      id: "cookie",
      title: "Cookie dan penyimpanan di peramban",
      paragraphs: [
        "Buku memakai cookie yang diperlukan untuk login dan menjaga sesi, serta cookie penanda sesi dukungan hanya baca bagi petugas Buku. Beberapa halaman menyimpan preferensi tampilan, seperti klien terakhir yang dibuka, di penyimpanan peramban perangkat Anda.",
        "Buku tidak memakai cookie analitik, cookie iklan, atau pelacak pihak ketiga. Menghapus cookie akan mengeluarkan Anda dari akun.",
      ],
    },
    {
      id: "keamanan",
      title: "Keamanan dan kegagalan pelindungan data",
      paragraphs: [
        "Koneksi ke Buku dienkripsi. Akses ke data mengikuti peran dan penugasan klien, setiap perubahan pembukuan dicatat, dan rahasia seperti kunci AI dan kata sandi PDF yang disimpan dienkripsi. Sesi dukungan memerlukan verifikasi dua langkah dan dicatat.",
        "Bila terjadi kegagalan pelindungan data pribadi, pengelola memberi tahu secara tertulis paling lambat 3 x 24 jam sesuai UU PDP: kepada subjek data dan lembaga yang berwenang untuk data yang pemrosesannya ditentukan pengelola, dan kepada organisasi untuk isi pembukuannya, agar organisasi dapat memenuhi kewajibannya. Pemberitahuan memuat data yang terdampak, kapan dan bagaimana kejadiannya, serta langkah penanganan dan pemulihan.",
      ],
    },
    trialAccess,
    support,
    retention,
    {
      id: "hak-data-pribadi",
      title: "Hak Anda atas data pribadi",
      paragraphs: [
        "Sesuai hak yang berlaku dalam UU Pelindungan Data Pribadi (UU PDP), Anda dapat meminta informasi pemrosesan, akses dan salinan data, melengkapi atau mengoreksi data, menarik persetujuan, mengajukan keberatan atau pembatasan pemrosesan, serta meminta penghentian pemrosesan atau penghapusan data. Hak tersebut berlaku sesuai dasar pemrosesan, ketentuan hukum, dan pengecualian yang relevan.",
        "Ajukan permintaan melalui kontak pengelola di bawah dengan menyebutkan organisasi dan data yang dimaksud. Jangan kirim kata sandi. Buku dapat memeriksa identitas dan kewenangan pemohon sebelum menindaklanjuti, serta menjelaskan bila kewajiban penyimpanan hukum atau akuntansi membatasi penghapusan. Penarikan persetujuan tidak membatalkan pemrosesan sah yang sudah dilakukan dan dapat memengaruhi fitur yang memerlukannya.",
      ],
    },
  ],
};
