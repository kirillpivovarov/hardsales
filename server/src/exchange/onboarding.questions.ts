// Generated from exchange_data/onboarding_questions.json (schema version 1).
export interface OnboardingQuestion {
  id: string;
  text: string;
  required: boolean;
}

export interface OnboardingQuestionGroup {
  key: 'seller' | 'buyer' | 'agent';
  title: string;
  questions: OnboardingQuestion[];
}

export const onboardingOptionalHeading = "По желанию: поможет оператору быстрее вас проверить";
export const onboardingAnswerMaxLength = 2000;

export const onboardingGroups: OnboardingQuestionGroup[] = [
  {
    "key": "seller",
    "title": "Продавцу",
    "questions": [
      {
        "id": "seller_01",
        "text": "Компания, страна, ваша роль в ней",
        "required": false
      },
      {
        "id": "seller_02",
        "text": "Вы владелец товара, официальный дистрибьютор или агент? Если агент: сколько звеньев до владельца товара?",
        "required": true
      },
      {
        "id": "seller_03",
        "text": "Какие позиции продаёте чаще всего?",
        "required": true
      },
      {
        "id": "seller_04",
        "text": "Где находятся склады?",
        "required": false
      },
      {
        "id": "seller_05",
        "text": "Обычный объём одной сделки (штук, порядок суммы)?",
        "required": false
      },
      {
        "id": "seller_06",
        "text": "Какие формы оплаты принимаете? Какие точно нет?",
        "required": true
      },
      {
        "id": "seller_07",
        "text": "Допускаете инспекцию на складе до оплаты?",
        "required": false
      },
      {
        "id": "seller_08",
        "text": "Какие документы даёте к поставке?",
        "required": false
      },
      {
        "id": "seller_09",
        "text": "Сколько времени нужно, чтобы прислать фото серийного номера с кодом дня?",
        "required": false
      },
      {
        "id": "seller_10",
        "text": "Кому продаёте сейчас и как находите покупателей?",
        "required": false
      }
    ]
  },
  {
    "key": "buyer",
    "title": "Покупателю",
    "questions": [
      {
        "id": "buyer_01",
        "text": "Компания, страна, ваша роль (ЛПР, закупки, агент)",
        "required": false
      },
      {
        "id": "buyer_02",
        "text": "Вы конечный заказчик или покупаете для клиента?",
        "required": true
      },
      {
        "id": "buyer_03",
        "text": "Что нужно сейчас (модели, количество, конфигурация)?",
        "required": true
      },
      {
        "id": "buyer_04",
        "text": "Для чего оборудование: своя инфраструктура, ЦОД, перепродажа?",
        "required": false
      },
      {
        "id": "buyer_05",
        "text": "Где готовы забирать товар? Есть ли свой логист?",
        "required": false
      },
      {
        "id": "buyer_06",
        "text": "Какие формы оплаты допустимы? Готовы открыть аккредитив?",
        "required": true
      },
      {
        "id": "buyer_07",
        "text": "Можете подтвердить наличие средств или готовность банка открыть аккредитив?",
        "required": false
      },
      {
        "id": "buyer_08",
        "text": "Срок, к которому нужен товар?",
        "required": false
      },
      {
        "id": "buyer_09",
        "text": "Нужна ли инспекция до оплаты и кто её проводит?",
        "required": false
      },
      {
        "id": "buyer_10",
        "text": "Сколько раз за последние полгода срывалась покупка и почему?",
        "required": false
      }
    ]
  },
  {
    "key": "agent",
    "title": "Агенту (дополнительно)",
    "questions": [
      {
        "id": "agent_01",
        "text": "Чью сторону представляете: продавца или покупателя?",
        "required": false
      },
      {
        "id": "agent_02",
        "text": "Есть ли письменный мандат или агентский договор? Эксклюзивный или нет?",
        "required": false
      },
      {
        "id": "agent_03",
        "text": "Сколько принципалов представляете сейчас?",
        "required": false
      },
      {
        "id": "agent_04",
        "text": "Как давно работаете с этим принципалом, были ли сделки?",
        "required": false
      },
      {
        "id": "agent_05",
        "text": "Есть ли у вас эксклюзив на лот?",
        "required": false
      },
      {
        "id": "agent_06",
        "text": "Кто платит ваше вознаграждение и в какой форме?",
        "required": false
      },
      {
        "id": "agent_07",
        "text": "Готовы ли вы, чтобы оператор связался с принципалом напрямую?",
        "required": false
      },
      {
        "id": "agent_08",
        "text": "Готовы раскрыть размер своего вознаграждения и кто его платит?",
        "required": false
      }
    ]
  }
];
