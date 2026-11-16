class AIService {
  // --- 1. PHÂN TÍCH BÀI VIẾT & BÌNH LUẬN ---
  checkPost(content) {
    if (!content) return { ok: false, error: 'Nội dung rỗng' };
    const text = content.toLowerCase();

    // Topic detection
    let topic = 'chung';
    if (text.includes('giá') || text.includes('bán') || text.includes('mua') || text.includes('sale') || text.includes('deal')) topic = 'bán hàng';
    else if (text.includes('chia sẻ') || text.includes('kinh nghiệm') || text.includes('hướng dẫn')) topic = 'chia sẻ kiến thức';
    else if (text.includes('hỏi') || text.includes('xin') || text.includes('tư vấn')) topic = 'hỏi đáp';

    // Sentiment analysis
    let sentiment = 'neutral';
    const positiveWords = ['tuyệt', 'đẹp', 'tốt', 'thích', 'ưng', 'chất lượng', 'uy tín', 'cảm ơn', 'yêu'];
    const negativeWords = ['lỗi', 'xấu', 'tệ', 'kém', 'lừa', 'thất vọng', 'hỏng', 'chán'];

    const hasPos = positiveWords.some(w => text.includes(w));
    const hasNeg = negativeWords.some(w => text.includes(w));

    if (hasPos && !hasNeg) sentiment = 'positive';
    else if (hasNeg) sentiment = 'negative';

    return {
      ok: true,
      topic,
      sentiment,
      wordCount: content.split(/\s+/).length,
      isSalesPost: topic === 'bán hàng'
    };
  }

  checkCmt(comment) {
    if (!comment) return { ok: false, error: 'Bình luận rỗng' };
    const text = comment.toLowerCase();

    let category = 'general';
    if (text.includes('ib') || text.includes('inbox') || text.includes('giá') || text.includes('nhiêu') || text.includes('bao nhiêu') || text.includes('tư vấn') || text.includes('ship')) {
      category = 'purchase_intent'; // Khách hỏi mua / hỏi giá
    } else if (text.includes('chậm') || text.includes('lỗi') || text.includes('kém') || text.includes('đổi') || text.includes('hoàn')) {
      category = 'complaint'; // Khiếu nại
    } else if (text.includes('đẹp') || text.includes('tuyệt') || text.includes('uy tín') || text.includes('ưng') || text.includes('chất')) {
      category = 'compliment'; // Khen ngợi
    }

    return {
      ok: true,
      category,
      shouldReplyImmediately: category === 'purchase_intent' || category === 'complaint'
    };
  }

  // --- 2. TỰ ĐỘNG SINH NỘI DUNG TƯƠNG TÁC ---
  writeCmt(postContent, tone = 'friendly') {
    const analysis = this.checkPost(postContent);

    const templates = {
      friendly: [
        '{Bài viết chia sẻ rất hay và hữu ích|Thông tin rất giá trị}, cảm ơn {bạn|chủ bài viết|ad} nhiều nhé! ❤️✨',
        '{Thả tim|Ủng hộ} cho bài viết chất lượng này nhé! Chúc {bạn|chủ thớt} ngày mới thật nhiều năng lượng và may mắn! 🌟',
        '{Tuyệt vời quá bạn ơi|Quá chuẩn luôn ạ}! Mình hoàn toàn đồng tình với quan điểm này. 👍'
      ],
      expert: [
        '{Góc nhìn rất thực tế và sâu sắc|Phân tích rất chuẩn xác}. Cảm ơn bạn đã chia sẻ kiến thức hữu ích này cho cộng đồng!',
        '{Nội dung mang lại nhiều giá trị thực tiễn|Rất đúng với tình hình thị trường hiện nay}. Chúc bạn ngày càng phát triển thành công hơn nữa!'
      ],
      buyer: [
        '{Sản phẩm này còn không bạn ơi|Shop cho mình xin thêm thông tin chi tiết với nhé}? {Đã nhắn tin cho shop rồi ạ|Check tin nhắn giúp mình nhé}! 📦',
        '{Sản phẩm trông đẹp và chất lượng quá|Nhìn ưng quá shop ơi}. {Tư vấn thêm cho mình với nha|Có freeship không ạ}?'
      ]
    };

    const chosenList = templates[tone] || templates.friendly;
    const randomTemplate = chosenList[Math.floor(Math.random() * chosenList.length)];
    return { ok: true, comment: randomTemplate, analysis };
  }

  writeReplyCmt(customerCmt, productInfo = '') {
    const check = this.checkCmt(customerCmt);

    if (check.category === 'purchase_intent') {
      return {
        ok: true,
        reply: '{Dạ chào bạn!|Chào bạn ạ!} {Shop đã gửi thông tin chi tiết và ưu đãi riêng qua tin nhắn cho bạn rồi nhé.|Shop xin phép gửi thông tin báo giá chi tiết qua tin nhắn ạ.} Bạn kiểm tra {hộp thư|tin nhắn} giúp shop nha! Cảm ơn bạn nhiều ạ! ❤️'
      };
    } else if (check.category === 'complaint') {
      return {
        ok: true,
        reply: '{Dạ chào bạn!|Dạ shop rất xin lỗi bạn vì trải nghiệm chưa được như ý ạ!|Shop chân thành xin lỗi bạn về sự bất tiện này ạ.} Bạn {cho shop xin số điện thoại|check tin nhắn} để shop hỗ trợ đổi trả và xử lý ngay lập tức cho bạn nhé!'
      };
    } else {
      return {
        ok: true,
        reply: '{Dạ cảm ơn bạn nhiều ạ!|Shop cảm ơn bạn đã quan tâm và ủng hộ nhé! ❤️} Chúc bạn một ngày thật nhiều niềm vui và may mắn ạ! ✨'
      };
    }
  }

  writeMessageForPost(topic, recipientName = 'bạn') {
    return {
      ok: true,
      spintaxTemplate: `{Chào|Xin chào|Hello} [name]! {Mình thấy bạn có quan tâm tới|Gửi tới bạn thông tin hữu ích về} ${topic}. {Nếu bạn cần thêm thông tin hay cần tư vấn chi tiết|Nếu bạn muốn tìm hiểu kỹ hơn}, {cứ nhắn lại cho mình nhé!|mình luôn sẵn sàng hỗ trợ bạn ạ!} Chúc [name] {một ngày làm việc hiệu quả|một ngày thật nhiều may mắn và niềm vui}! 🎉✨`
    };
  }
}

module.exports = new AIService();
