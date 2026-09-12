/** 单管理员可访问性表单，不回显服务端身份错误。 / Accessible single-owner form without reflecting server identity errors. */
export function authForm(
  submit: (password: string) => Promise<void>,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel auth-panel";
  const title = document.createElement("h2");
  title.textContent = "管理员登录";
  const owner = document.createElement("p");
  owner.textContent = "唯一管理员：redacted@example.invalid";
  const form = document.createElement("form");
  const inputs: HTMLInputElement[] = [];
  const add = (
    labelText: string,
    name: string,
    autocomplete: string,
  ): HTMLInputElement => {
    const label = document.createElement("label");
    label.className = "field";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "password";
    input.name = name;
    input.setAttribute("autocomplete", autocomplete);
    input.required = true;
    label.append(input);
    form.append(label);
    inputs.push(input);
    return input;
  };
  const password = add("密码", "password", "current-password");
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.setAttribute("aria-live", "polite");
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "登录";
  form.append(message, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    message.textContent = "正在验证…";
    try {
      await submit(password.value);
      form.reset();
      message.textContent = "操作成功。";
    } catch {
      inputs.forEach((input) => {
        input.value = "";
      });
      message.textContent = "验证失败或服务暂不可用，请检查输入后重试。";
      password.focus();
    } finally {
      button.disabled = false;
    }
  });
  section.append(title, owner, form);
  return section;
}
