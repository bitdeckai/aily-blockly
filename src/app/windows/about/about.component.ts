import { Component } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { TranslateModule } from '@ngx-translate/core';
import { version } from '../../../../package.json';

@Component({
  selector: 'app-about',
  imports: [
    SubWindowComponent,
    TranslateModule
  ],
  templateUrl: './about.component.html',
  styleUrl: './about.component.scss'
})
export class AboutComponent {
  readonly version = version;
}
