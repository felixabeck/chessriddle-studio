---
id: feedback
title: Comentarios, registros, borrar datos guardados y actualizaciones
summary: Envía comentarios, abre los registros de la aplicación, recarga o borra los datos guardados, consulta la versión e instala actualizaciones.
source: 8b0ca5aebb70e04f
---

Usa [[feedback]] ({{label:Menu.Help.SendFeedback}}) para informar de un error, sugerir una función, enviar un elogio o compartir otros comentarios directamente con el desarrollador.

Puedes abrir el formulario de comentarios en cualquier momento desde el botón {{label:Navigation.Feedback}} en la barra de navegación o desde {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}}.

En el formulario de comentarios puedes elegir un tipo ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} o {{label:Feedback.Type.Other}}), escribir un mensaje (de 10 a 5.000 caracteres), indicar opcionalmente una dirección de correo electrónico para recibir respuesta y adjuntar de forma opcional una captura de pantalla ({{label:Feedback.TakeScreenshot}}) o una imagen ({{label:Feedback.ChooseImage}}). La versión de la aplicación y el sistema operativo se envían junto con el mensaje.

Cuando el Assistant prepara un borrador de comentario para ti, al hacer clic en [[feedback]] se abre el formulario rellenado con ese borrador. No se envía nada hasta que revises el texto y hagas clic en {{label:Feedback.Submit}}.

Las herramientas de diagnóstico están en [[settings-category:advanced]] ({{label:Settings.Advanced}}):
- **Registros**: abre [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) para abrir la carpeta que contiene los archivos de registro de la aplicación.
- **Recargar**: abre [[setting:reload]] ({{label:Menu.View.Reload}}) para recargar la ventana de la aplicación.
- **Borrar datos guardados**: abre [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) para restablecer la configuración y los datos de sesión guardados tras confirmarlo. Esto no elimina tus archivos PGN ni bases de datos del espacio de trabajo, y queda bloqueado si los datos de práctica no pueden migrarse de forma segura.

**Versión de la aplicación y actualizaciones**:
- Consulta la versión instalada, la versión de Tauri y el sistema operativo mediante {{label:Menu.Help}} -> {{label:Menu.Help.About}} (en macOS, bajo el menú de la aplicación), o al final de [[page:settings]].
- Studio busca actualizaciones automáticamente tras iniciarse. Cuando hay una actualización disponible, un cuadro de confirmación te pregunta si quieres descargarla e instalarla. Si tienes cambios sin guardar, el reinicio se pospone hasta que guardes o reinicies la aplicación.
